import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Download, MessageSquare, Package, RefreshCcw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { DeepLinkPreviewDialog } from "@/components/deeplink/deeplink-preview-dialog";
import { toast } from "sonner";
import { ActionButton, ConfirmDialog, EmptyState, FieldLabel, ShellCard, SkeletonCard, SkeletonList, StatusPill } from "@/components/core/primitives";
import { HelpTooltip } from "@/components/core/help-tooltip";
import { SkillImportWizard } from "@/components/core/skill-import-wizard";
import { SkillScannerPanel } from "@/components/core/skill-scanner-panel";
import { HIDE_MARKETPLACE_UI } from "@/lib/feature-flags";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { skillsApi } from "@/lib/api/skills";
import { buildObservabilityHref } from "@/lib/observability/view-models";
import { readLastSkillGeneratorSessionId } from "@/lib/skills/generator-session";
import { trackStarterSkillBatch, trackStarterSkillEvent } from "@/lib/skills/starter-skill-telemetry";
import {
  buildSkillGeneratorHref,
  buildSkillHref,
  buildSkillOperatorSections,
  chooseInitialSkillId,
  summarizeSkillVerification,
  toneForSkillLifecycle,
  type FridaySkillFocus,
} from "@/lib/skills/view-models";

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function isCliFirstSkill(input: { originType?: string; tags: string[] }) {
  return input.originType === "cli-backed" || input.tags.includes("starter.cli") || input.tags.includes("cli-backed");
}

function toneForMaturity(maturity?: "draft" | "verified" | "stable"): "neutral" | "success" | "warning" {
  if (maturity === "stable") return "success";
  if (maturity === "verified") return "warning";
  return "neutral";
}

function formatOriginType(originType: string | undefined, locale: AppLocale): string {
  if (originType === "cli-backed") return localize(locale, "CLI 驱动", "CLI-backed");
  if (originType === "mcp-backed") return localize(locale, "MCP 驱动", "MCP-backed");
  if (originType === "stabilized") return localize(locale, "已稳定", "Stabilized");
  return localize(locale, "AI 生成", "Generated");
}

function formatMaturity(maturity: string | undefined, locale: AppLocale): string {
  if (maturity === "stable") return localize(locale, "稳定", "Stable");
  if (maturity === "verified") return localize(locale, "已验证", "Verified");
  return localize(locale, "草稿", "Draft");
}

function toneForCatalogReadiness(item: {
  blockedReasons?: string[];
  recommendedNextAction?: string;
}): "success" | "warning" | "neutral" {
  if ((item.blockedReasons?.length ?? 0) > 0) {
    return "warning";
  }
  if (item.recommendedNextAction) {
    return "success";
  }
  return "neutral";
}

function labelForCatalogReadiness(item: {
  blockedReasons?: string[];
  recommendedNextAction?: string;
}, locale: AppLocale): string {
  if ((item.blockedReasons?.length ?? 0) > 0) {
    return localize(locale, "需要审核", "needs review");
  }
  if (item.recommendedNextAction) {
    return localize(locale, "就绪", "ready");
  }
  return localize(locale, "目录", "catalog");
}

function describeIntegrationMode(input: {
  originType?: "generated" | "stabilized" | "cli-backed" | "mcp-backed";
  tags: string[];
}, locale: AppLocale): string {
  if (input.originType === "cli-backed" || isCliFirstSkill(input)) {
    return locale === "zh" ? "优先使用 CLI 驱动技能" : "Prefer CLI-backed skill";
  }
  if (input.originType === "mcp-backed") {
    return locale === "zh" ? "优先使用 MCP 驱动技能" : "Prefer MCP-backed skill";
  }
  if (input.originType === "stabilized") {
    return locale === "zh" ? "优先使用稳定技能" : "Prefer stable skill";
  }
  return locale === "zh" ? "优先使用生成草稿，直到验证证明应被稳定化" : "Prefer generated draft until verification proves it should be stabilized";
}

function describeStabilizationPath(input: {
  originType?: "generated" | "stabilized" | "cli-backed" | "mcp-backed";
  maturity?: "draft" | "verified" | "stable";
}, locale: AppLocale): string {
  if (input.originType === "stabilized" || input.originType === "cli-backed" || input.originType === "mcp-backed") {
    return locale === "zh"
      ? `生成 -> ${input.originType} -> ${input.maturity ?? "草稿"}`
      : `generated -> ${input.originType} -> ${input.maturity ?? "draft"}`;
  }
  return locale === "zh"
    ? `草稿 -> ${input.maturity ?? "草稿"}`
    : `draft -> ${input.maturity ?? "draft"}`;
}

function toneForPreflightVerdict(
  verdict?: "ready" | "needs_review" | "blocked",
): "success" | "warning" | "danger" | "neutral" {
  if (verdict === "ready") return "success";
  if (verdict === "needs_review") return "warning";
  if (verdict === "blocked") return "danger";
  return "neutral";
}

function labelForPreflightVerdict(
  verdict?: "ready" | "needs_review" | "blocked",
  locale?: AppLocale,
): string {
  if (verdict === "ready") return locale === "zh" ? "就绪" : "ready";
  if (verdict === "needs_review") return locale === "zh" ? "需要审核" : "needs review";
  if (verdict === "blocked") return locale === "zh" ? "已阻止" : "blocked";
  return locale === "zh" ? "未知" : "unknown";
}

export function SkillsPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [recentGeneratorSessionId, setRecentGeneratorSessionId] = useState<string | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [deleteConfirmSkillId, setDeleteConfirmSkillId] = useState<string | null>(null);
  const [deleteConfirmSourceId, setDeleteConfirmSourceId] = useState<string | null>(null);
  const [deleteConfirmSourceName, setDeleteConfirmSourceName] = useState<string | null>(null);
  const [sourceNameInput, setSourceNameInput] = useState("");
  const [sourceBaseUrlInput, setSourceBaseUrlInput] = useState("");
  const [sourceTrustPolicy, setSourceTrustPolicy] = useState<"strict" | "warn" | "permissive">("warn");
  // Edit mode removed — skills use "Regenerate" flow instead of inline editing
  const requestedSkillId = searchParams.get("skillId");
  const requestedFocus = searchParams.get("focus");
  const focus: FridaySkillFocus =
    requestedFocus === "install" || requestedFocus === "verify" || (!HIDE_MARKETPLACE_UI && requestedFocus === "sources")
      ? requestedFocus
      : "details";

  const skillsQuery = useQuery({
    queryKey: ["skills", "list"],
    queryFn: () => skillsApi.listSkills(),
    refetchInterval: 15_000,
  });

  const catalogQuery = useQuery({
    queryKey: ["skills", "catalog"],
    queryFn: () => skillsApi.listCatalog({ limit: 50 }),
    enabled: !HIDE_MARKETPLACE_UI,
    refetchInterval: 30_000,
  });

  const sourcesQuery = useQuery({
    queryKey: ["skills", "sources"],
    queryFn: () => skillsApi.listSources(),
    enabled: !HIDE_MARKETPLACE_UI,
    refetchInterval: 30_000,
  });

  const skills = skillsQuery.data ?? [];
  const catalog = HIDE_MARKETPLACE_UI ? [] : (catalogQuery.data?.items ?? []);
  const sections = buildSkillOperatorSections({ skills, catalog });

  useEffect(() => {
    setRecentGeneratorSessionId(readLastSkillGeneratorSessionId());
  }, []);

  useEffect(() => {
    if (sections.starter.length === 0) return;
    trackStarterSkillBatch("starter_skill_shown", {
      skillIds: sections.starter.map((skill) => skill.skillId),
      source: "skills_page",
      metadata: { count: sections.starter.length },
    });
  }, [sections.starter]);

  useEffect(() => {
    if (
      requestedSkillId &&
      (skills.some((skill) => skill.skillId === requestedSkillId) || catalog.some((item) => item.skillId === requestedSkillId))
    ) {
      if (requestedSkillId !== selectedSkillId) {
        setSelectedSkillId(requestedSkillId);
      }
      return;
    }

    const nextId = chooseInitialSkillId({
      selectedSkillId,
      skills,
      catalog,
    });
    if (nextId && nextId !== selectedSkillId) {
      setSelectedSkillId(nextId);
      setSearchParams(new URLSearchParams(buildSkillHref(nextId, focus).replace("/skills?", "")), { replace: true });
    }
  }, [catalog, focus, requestedSkillId, selectedSkillId, setSearchParams, skills]);

  const handleSelectSkill = (skillId: string) => {
    setSelectedSkillId(skillId);
    setSearchParams(new URLSearchParams(buildSkillHref(skillId, focus).replace("/skills?", "")), { replace: false });
  };

  const detailQuery = useQuery({
    queryKey: ["skills", "detail", selectedSkillId],
    queryFn: () => skillsApi.getSkill(selectedSkillId!),
    enabled: selectedSkillId !== null,
    refetchInterval: 10_000,
  });

  const verifyMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.verifySkill(skillId),
    onSuccess: (_, skillId) => {
      toast.success(localize(locale, "技能验证完成", "Skill verification completed"));
      void queryClient.invalidateQueries({ queryKey: ["skills", "detail", skillId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "技能验证失败", "Skill verification failed"));
    },
  });

  const installMutation = useMutation({
    mutationFn: (skillId: string) => {
      const sourceId = catalog.find((item) => item.skillId === skillId)?.sourceId;
      return skillsApi.installSkill({ skillId, sourceId });
    },
    onSuccess: (result) => {
      toast.success(locale === "zh" ? `已安装 ${result.skill.name}` : `Installed ${result.skill.name}`);
      setSelectedSkillId(result.skill.skillId);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "技能安装失败", "Skill install failed"));
    },
  });

  const updateMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.updateSkill(skillId),
    onSuccess: (result) => {
      toast.success(result.updated
        ? (locale === "zh" ? `已更新 ${result.skill.name}` : `Updated ${result.skill.name}`)
        : (locale === "zh" ? `${result.skill.name} 已是最新版本` : `${result.skill.name} is already current`));
      setSelectedSkillId(result.skill.skillId);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "技能更新失败", "Skill update failed"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.deleteSkill(skillId),
    onSuccess: (_, skillId) => {
      toast.success(locale === "zh" ? `已移除 ${skillId}` : `Removed ${skillId}`);
      if (selectedSkillId === skillId) {
        setSelectedSkillId(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "技能移除失败", "Skill removal failed"));
    },
  });

  const toggleSourceMutation = useMutation({
    mutationFn: (input: { sourceId: string; enabled: boolean }) =>
      input.enabled ? skillsApi.disableSource(input.sourceId) : skillsApi.enableSource(input.sourceId),
    onSuccess: () => {
      toast.success(localize(locale, "市场来源已更新", "Marketplace source updated"));
      void queryClient.invalidateQueries({ queryKey: ["skills", "sources"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法更新来源", "Could not update the source"));
    },
  });

  const createSourceMutation = useMutation({
    mutationFn: () =>
      skillsApi.createSource({
        name: sourceNameInput.trim(),
        baseUrl: sourceBaseUrlInput.trim(),
        trustPolicy: sourceTrustPolicy,
      }),
    onSuccess: (source) => {
      toast.success(locale === "zh" ? `已新增来源 ${source.name}` : `Added source ${source.name}`);
      setSourceNameInput("");
      setSourceBaseUrlInput("");
      setSourceTrustPolicy("warn");
      void queryClient.invalidateQueries({ queryKey: ["skills", "sources"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法新增来源", "Could not add marketplace source"));
    },
  });

  const syncSourceMutation = useMutation({
    mutationFn: (sourceId?: string) => skillsApi.syncSources(sourceId ? { sourceId } : {}),
    onSuccess: (result, sourceId) => {
      const failedResults = result.results.filter((item) => item.errors.length > 0);
      if (failedResults.length > 0) {
        const firstError = failedResults[0]?.errors[0];
        toast.error(firstError ?? localize(locale, "来源同步失败", "Marketplace sync failed"));
      } else {
        const label = sourceId
          ? localize(locale, "来源目录已同步", "Source catalog synced")
          : localize(locale, "市场目录已同步", "Marketplace catalog synced");
        const summary = locale === "zh"
          ? `${label} · ${result.results.reduce((sum, item) => sum + item.skillsSynced, 0)} 个技能`
          : `${label} · ${result.results.reduce((sum, item) => sum + item.skillsSynced, 0)} skills`;
        toast.success(summary);
      }
      void queryClient.invalidateQueries({ queryKey: ["skills", "sources"] });
      void queryClient.invalidateQueries({ queryKey: ["skills", "catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["skills", "list"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法同步来源", "Could not sync marketplace source"));
    },
  });

  const deleteSourceMutation = useMutation({
    mutationFn: (sourceId: string) => skillsApi.deleteSource(sourceId),
    onSuccess: (_, sourceId) => {
      toast.success(locale === "zh" ? `已移除来源 ${sourceId}` : `Removed source ${sourceId}`);
      if (deleteConfirmSourceId === sourceId) {
        setDeleteConfirmSourceId(null);
        setDeleteConfirmSourceName(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["skills", "sources"] });
      void queryClient.invalidateQueries({ queryKey: ["skills", "catalog"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法移除来源", "Could not remove marketplace source"));
    },
  });

  const detail = detailQuery.data;
  const selectedCatalog = selectedSkillId
    ? catalog.find((item) => item.skillId === selectedSkillId) ?? null
    : null;
  const canCreateSource = sourceNameInput.trim().length > 0 && sourceBaseUrlInput.trim().length > 0;

  useEffect(() => {
    if (!detail?.starter) return;
    trackStarterSkillEvent("starter_skill_detail_opened", {
      skillId: detail.skillId,
      source: "skills_page",
      metadata: { origin: detail.origin },
    });
  }, [detail?.origin, detail?.skillId, detail?.starter]);

  return (
    <div data-testid="skills-page" className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-4">
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowScanner(true)}
            data-testid="skills-scanner-button"
            className="inline-flex items-center gap-1.5 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1.5 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]"
          >
            <Search className="h-3.5 w-3.5" />
            {localize(locale, "扫描与迁移", "Scan & Migrate")}
          </button>
          <button
            type="button"
            onClick={() => setShowImportWizard(true)}
            data-testid="skills-import-button"
            className="inline-flex items-center gap-1.5 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1.5 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]"
          >
            <Download className="h-3.5 w-3.5" />
            {localize(locale, "导入技能", "Import Skill")}
          </button>
        </div>
        {showImportDialog ? (
          <DeepLinkPreviewDialog
            onClose={() => setShowImportDialog(false)}
            onApplied={() => {
              void queryClient.invalidateQueries({ queryKey: ["skills"] });
            }}
          />
        ) : null}
        <ShellCard
          eyebrow={localize(locale, "生成器", "Generator")}
          title={localize(locale, "通过引导会话打包技能", "Package a skill from a guided session")}
          aside={<StatusPill tone={recentGeneratorSessionId ? "success" : "neutral"}>{recentGeneratorSessionId ? localize(locale, "可恢复", "resume ready") : localize(locale, "新会话", "new session")}</StatusPill>}
        >
          <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
            <p>
              {locale === "zh"
                ? "当你需要澄清问题、生成草稿、测试证据以及最终审批回执时，使用专用的生成器界面。"
                : "Use the dedicated generator surface when you want clarification questions, draft generation, test evidence, and the final approve receipt in one place."}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                className="inline-flex items-center rounded-2xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)]"
                to={buildSkillGeneratorHref({
                  goal: detail ? `Create or stabilize a reusable skill for: ${detail.name}` : undefined,
                  from: "skills",
                })}
              >
                <Package className="mr-2 h-4 w-4" />
                {localize(locale, "打开生成器", "Open generator")}
              </Link>
              {recentGeneratorSessionId ? (
                <Link
                  className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                  to={buildSkillGeneratorHref({
                    sessionId: recentGeneratorSessionId,
                    from: "skills",
                  })}
                >
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  {localize(locale, "恢复上次会话", "Resume last session")}
                </Link>
              ) : null}
            </div>
          </div>
        </ShellCard>

        <ShellCard
          eyebrow={localize(locale, "助手交接", "Assistant Handoff")}
          title={localize(locale, "无需触碰代码即可安装、验证和修复技能", "Install, verify, and repair skills without touching code")}
          aside={
            selectedSkillId ? (
                <StatusPill tone={detail?.installedVersion || detail?.registryLoaded ? "success" : "warning"}>
                  {focus === "install"
                    ? localize(locale, "安装焦点", "install focus")
                    : focus === "verify"
                      ? localize(locale, "验证焦点", "verify focus")
                      : !HIDE_MARKETPLACE_UI && focus === "sources"
                        ? localize(locale, "来源焦点", "source focus")
                        : detail?.installedVersion || detail?.registryLoaded
                          ? localize(locale, "可操作", "actionable")
                          : localize(locale, "仅目录", "catalog only")}
                </StatusPill>
              ) : undefined
          }
        >
          {selectedSkillId ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <p>
                {locale === "zh"
                  ? "Friday 使用此页面作为助手已推荐技能的操作员详情视图。核心生命周期保持点击优先：先是入门包，然后是托管安装、信任证据、更新和修复操作。"
                  : "Friday uses this page as the operator detail view for a skill that Assistant has already recommended. The core lifecycle stays click-first: starter pack first, then managed installs, trust evidence, updates, and repair actions."}
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                <SkillMetric label={localize(locale, "选中技能", "Selected skill")} value={detail?.name ?? selectedCatalog?.skillName ?? selectedSkillId} />
                <SkillMetric label={localize(locale, "生命周期状态", "Lifecycle state")} value={detail?.status ?? localize(locale, "目录", "catalog")} />
                <SkillMetric label={localize(locale, "来源", "Origin")} value={formatOriginType(detail?.originType ?? selectedCatalog?.originType, locale)} />
                <SkillMetric label={localize(locale, "成熟度", "Maturity")} value={formatMaturity(detail?.maturity ?? selectedCatalog?.maturity, locale)} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "选择一个已安装或内置技能以查看最佳的安装、验证或修复操作。", "Pick an installed or bundled skill to see the next best install, verify, or repair action.")}</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow={localize(locale, "内置入门包", "Bundled Starter Pack")}
          title={locale === "zh" ? <>Friday 内置的入门<HelpTooltip term="skill">技能</HelpTooltip></> : <>Starter <HelpTooltip term="skill">skills</HelpTooltip> that ship with Friday</>}
          aside={<StatusPill tone={sections.starter.length > 0 ? "success" : "neutral"}>{sections.starter.length} {localize(locale, "个内置", "bundled")}</StatusPill>}
        >
          <div className="space-y-3">
            {sections.starter.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "暂无可见的内置入门技能。", "No bundled starter skills are visible yet.")}</p>
            ) : (
              sections.starter.map((skill) => (
                <button
                  key={skill.skillId}
                  type="button"
                  onClick={() => handleSelectSkill(skill.skillId)}
                  className="agent-selection-card"
                  data-active={skill.skillId === selectedSkillId}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{skill.name}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{skill.skillId}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill tone="success">{localize(locale, "入门", "starter")}</StatusPill>
                      <StatusPill tone={toneForSkillLifecycle(skill)}>{skill.status}</StatusPill>
                      <StatusPill>{formatOriginType(skill.originType, locale)}</StatusPill>
                      <StatusPill tone={toneForMaturity(skill.maturity)}>{formatMaturity(skill.maturity, locale)}</StatusPill>
                      {isCliFirstSkill(skill) ? <StatusPill tone="success">{localize(locale, "CLI 优先", "CLI-first")}</StatusPill> : null}
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    {skill.description || localize(locale, "内置入门技能。", "Bundled starter skill.")}
                  </p>
                </button>
              ))
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow={localize(locale, "已安装 / 托管", "Installed / Managed")}
          title={locale === "zh" ? <>选择 Friday 应托管的<HelpTooltip term="skill">技能</HelpTooltip></> : <>Choose the <HelpTooltip term="skill" /> Friday should manage</>}
          aside={<StatusPill tone={sections.installed.length > 0 ? "success" : "neutral"}>{sections.installed.length} {localize(locale, "个托管", "managed")}</StatusPill>}
        >
          <div className="space-y-3">
            {sections.installed.length === 0 ? (
              <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <p>{localize(locale, "暂无托管技能。Friday 仍可立即使用内置入门包。", "No managed skills yet. Friday can still use the bundled starter pack immediately.")}</p>
                <p>{localize(locale, "告诉 Friday 你想自动化什么，它会创建或安装合适的技能。", "Tell Friday what you want to automate and it will create or install the right skill.")}</p>
                <Link to="/chat" className="inline-flex items-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)]">{localize(locale, "在聊天中询问 Friday", "Ask Friday in Chat")}</Link>
              </div>
            ) : (
              sections.installed.map((skill) => (
                <button
                  key={skill.skillId}
                  type="button"
                  onClick={() => handleSelectSkill(skill.skillId)}
                  className="agent-selection-card"
                  data-active={skill.skillId === selectedSkillId}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{skill.name}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{skill.skillId}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill tone={toneForSkillLifecycle(skill)}>
                        {skill.updateAvailable ? localize(locale, "有更新", "update available") : skill.status}
                      </StatusPill>
                      <StatusPill>{formatOriginType(skill.originType, locale)}</StatusPill>
                      <StatusPill tone={toneForMaturity(skill.maturity)}>{formatMaturity(skill.maturity, locale)}</StatusPill>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    {skill.description || localize(locale, "暂无描述。", "No description available.")}
                  </p>
                  {isCliFirstSkill(skill) ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">
                      {localize(locale, "CLI 优先：此技能已配置为优先使用本地直接执行，而非较重的工具桥接。", "CLI-first: this skill is already shaped to prefer direct local execution over heavier tool bridges.")}
                    </p>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow={localize(locale, "更新", "Updates")}
          title={localize(locale, "需要关注的技能", "Skills that need attention")}
          aside={<StatusPill tone={sections.updates.length > 0 ? "warning" : "success"}>{sections.updates.length} {localize(locale, "个待处理", "pending")}</StatusPill>}
        >
          <div className="space-y-3">
            {sections.updates.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "所有已安装技能均为最新跟踪版本。", "All installed skills are at the latest tracked version.")}</p>
            ) : (
              sections.updates.map((skill) => (
                <div key={skill.skillId} className="agent-subcard p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{skill.name}</p>
                      <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
                        {localize(locale, "已安装", "Installed")} {skill.installedVersion ?? localize(locale, "未知", "unknown")} · {localize(locale, "最新", "Latest")} {skill.latestVersion ?? localize(locale, "未知", "unknown")}
                      </p>
                    </div>
                    <ActionButton
                      onClick={() => void updateMutation.mutateAsync(skill.skillId)}
                      disabled={updateMutation.isPending}
                    >
                      <RefreshCcw className="mr-2 h-4 w-4" />
                      {localize(locale, "更新", "Update")}
                    </ActionButton>
                  </div>
                </div>
              ))
            )}
          </div>
        </ShellCard>

        {!HIDE_MARKETPLACE_UI ? (
          <ShellCard
            eyebrow={localize(locale, "市场", "Marketplace")}
            title={localize(locale, "可安装的新技能", "New skills you can install")}
            aside={<StatusPill tone={sections.available.length > 0 ? "neutral" : "success"}>{sections.available.length} {localize(locale, "个可发现", "discoverable")}</StatusPill>}
          >
            <div className="space-y-3">
              {sections.available.length === 0 ? (
                <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                  <p>
                    {(sourcesQuery.data?.length ?? 0) === 0
                      ? localize(
                        locale,
                        "当前没有配置任何外部市场来源，所以公共目录为空是预期行为，不是前端坏了。",
                        "No external marketplace sources are configured right now, so an empty public catalog is expected rather than a frontend failure.",
                      )
                      : localize(
                        locale,
                        "Friday 当前在已安装集之外未发现任何目录条目。",
                        "Friday does not currently see any catalog entries beyond the installed set.",
                      )}
                  </p>
                  <p className="text-xs text-[color:var(--color-text-tertiary)]">
                    {(sourcesQuery.data?.length ?? 0) === 0
                      ? localize(
                        locale,
                        "内置入门技能和已安装技能仍然可用；这里只是在如实反映 /v1/marketplace/sources 和 /v1/skills/catalog 的当前空状态。",
                        "Bundled starter skills and installed skills still work; this section is simply reflecting the current empty state of /v1/marketplace/sources and /v1/skills/catalog.",
                      )
                      : localize(
                        locale,
                        "当前已跟踪来源没有提供新的可安装目录项。",
                        "The currently tracked sources are not exposing any additional installable catalog items.",
                      )}
                  </p>
                </div>
              ) : (
                sections.available.slice(0, 8).map((item) => (
                  <button
                    key={`${item.skillId}:${item.version}`}
                    type="button"
                    onClick={() => handleSelectSkill(item.skillId)}
                    className="agent-selection-card"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{item.skillName}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{item.skillId}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill tone={toneForCatalogReadiness(item)}>
                          {labelForCatalogReadiness(item, locale)}
                        </StatusPill>
                        <StatusPill tone={item.signatureValid ? "success" : "warning"}>
                          {localize(locale, "信任", "trust")} {item.trustScore}
                        </StatusPill>
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                      {localize(locale, "版本", "Version")} {item.version} · {item.publisher ?? localize(locale, "未知发布者", "Unknown publisher")}
                    </p>
                    {item.recommendedNextAction ? (
                      <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">
                        {item.recommendedNextAction}
                      </p>
                    ) : null}
                    {item.blockedReasons && item.blockedReasons.length > 0 ? (
                      <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                        {localize(locale, "已阻止", "Blocked")}: {item.blockedReasons[0]}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.originType ? <StatusPill>{formatOriginType(item.originType, locale)}</StatusPill> : null}
                      {item.maturity ? (
                        <StatusPill tone={toneForMaturity(item.maturity)}>{formatMaturity(item.maturity, locale)}</StatusPill>
                      ) : null}
                      {item.trustTier ? <StatusPill>{item.trustTier}</StatusPill> : null}
                      {item.firstUsePrompts?.slice(0, 2).map((prompt) => (
                        <StatusPill key={prompt} tone="neutral">{prompt}</StatusPill>
                      ))}
                    </div>
                  </button>
                ))
              )}
            </div>
          </ShellCard>
        ) : null}
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow={localize(locale, "技能详情", "Skill Detail")}
          title={detail?.name ?? selectedCatalog?.skillName ?? localize(locale, "选择一个技能", "Select a skill")}
          aside={
            detail ? (
              <StatusPill tone={toneForSkillLifecycle(detail)}>
                {detail.updateAvailable ? localize(locale, "有更新", "update available") : detail.status}
              </StatusPill>
            ) : undefined
          }
        >
          {!selectedSkillId ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "选择已安装或内置技能以检查生命周期证据。", "Select an installed or bundled skill to inspect lifecycle evidence.")}</p>
          ) : detail ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <div className="agent-subcard p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{detail.name}</p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{detail.skillId}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {detail.starter ? <StatusPill tone="success">{localize(locale, "入门包", "starter pack")}</StatusPill> : null}
                    <StatusPill tone={toneForSkillLifecycle(detail)}>
                      {detail.installedVersion ?? detail.latestVersion ?? localize(locale, "无版本", "unversioned")}
                    </StatusPill>
                    <StatusPill>{formatOriginType(detail.originType, locale)}</StatusPill>
                    <StatusPill tone={toneForMaturity(detail.maturity)}>{formatMaturity(detail.maturity, locale)}</StatusPill>
                    {isCliFirstSkill(detail) ? <StatusPill tone="success">{localize(locale, "CLI 优先", "CLI-first")}</StatusPill> : null}
                  </div>
                </div>
                <p className="mt-3 text-[color:var(--color-text-secondary)]">
                  {detail.description || localize(locale, "此技能暂无描述记录。", "No description recorded for this skill.")}
                </p>
                {detail.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {detail.tags.map((tag) => (
                      <span key={tag} className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-2.5 py-0.5 text-xs text-[color:var(--color-text-tertiary)]">{tag}</span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-4 grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
                  <p>{localize(locale, "来源", "Source")}: {detail.source}</p>
                  <p>{localize(locale, "起源", "Origin")}: {detail.origin}</p>
                  <p>{localize(locale, "发布者", "Publisher")}: {detail.publisher ?? localize(locale, "未知", "Unknown")}</p>
                  <p>{localize(locale, "已安装版本", "Installed version")}: {detail.installedVersion ?? localize(locale, "未安装", "not installed")}</p>
                  <p>{localize(locale, "最新版本", "Latest version")}: {detail.latestVersion ?? localize(locale, "未知", "unknown")}</p>
                  <p>{localize(locale, "入门包", "Starter pack")}: {detail.starter ? localize(locale, "是", "yes") : localize(locale, "否", "no")}</p>
                  <p>{localize(locale, "来源类型", "Origin type")}: {formatOriginType(detail.originType, locale)}</p>
                  <p>{localize(locale, "成熟度", "Maturity")}: {formatMaturity(detail.maturity, locale)}</p>
                </div>
                {!HIDE_MARKETPLACE_UI && detail.catalogEntry?.recommendedNextAction ? (
                  <div className="mt-4 rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 text-sm text-[color:var(--color-text-secondary)]">
                    <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "最佳下一步操作", "Next best action")}</p>
                    <p className="mt-2">{detail.catalogEntry.recommendedNextAction}</p>
                    {detail.catalogEntry.blockedReasons && detail.catalogEntry.blockedReasons.length > 0 ? (
                      <div className="mt-3 space-y-1 text-xs text-[color:var(--color-text-tertiary)]">
                        {detail.catalogEntry.blockedReasons.map((reason) => (
                          <p key={reason}>{localize(locale, "已阻止", "Blocked")}: {reason}</p>
                        ))}
                      </div>
                    ) : null}
                    {detail.catalogEntry.firstUsePrompts && detail.catalogEntry.firstUsePrompts.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {detail.catalogEntry.firstUsePrompts.map((prompt) => (
                          <StatusPill key={prompt}>{prompt}</StatusPill>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Link
                    className="inline-flex items-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildSkillGeneratorHref({
                      goal: locale === "zh"
                        ? `基于现有技能"${detail.name}"重新生成一个改进版本。原始描述：${detail.description ?? ""}`
                        : `Regenerate an improved version based on existing skill "${detail.name}". Original description: ${detail.description ?? ""}`,
                      from: "skills",
                    })}
                  >
                    <RefreshCcw className="mr-2 h-4 w-4" />
                    {localize(locale, "重新生成", "Regenerate")}
                  </Link>
                  {detail.installedVersion ? (
                    <ActionButton
                      onClick={() => void verifyMutation.mutateAsync(detail.skillId)}
                      disabled={verifyMutation.isPending}
                    >
                      <BadgeCheck className="mr-2 h-4 w-4" />
                      {localize(locale, "验证", "Verify")}
                    </ActionButton>
                  ) : (
                    <ActionButton
                      onClick={() => void installMutation.mutateAsync(detail.skillId)}
                      disabled={installMutation.isPending}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {localize(locale, "安装", "Install")}
                    </ActionButton>
                  )}
                  {detail.updateAvailable ? (
                    <ActionButton
                      tone="secondary"
                      onClick={() => void updateMutation.mutateAsync(detail.skillId)}
                      disabled={updateMutation.isPending}
                    >
                      <RefreshCcw className="mr-2 h-4 w-4" />
                      {localize(locale, "更新", "Update")}
                    </ActionButton>
                  ) : null}
                  {!detail.starter && (detail.installedVersion || detail.registryLoaded) ? (
                    <ActionButton
                      tone="danger"
                      onClick={() => setDeleteConfirmSkillId(detail.skillId)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {localize(locale, "移除", "Remove")}
                    </ActionButton>
                  ) : null}
                  <Link
                    className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildObservabilityHref({ focus: "assistant" })}
                  >
                    {localize(locale, "打开诊断", "Open diagnostics")}
                  </Link>
                  <Link
                    className="inline-flex items-center gap-1.5 rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={`/chat?prefill=${encodeURIComponent(locale === "zh" ? `修改技能 "${detail.name}" 的` : `Modify skill "${detail.name}"`)}`}
                  >
                    <MessageSquare className="h-4 w-4" />
                    {localize(locale, "和 Friday 对话修改", "Modify via Chat")}
                  </Link>
                </div>
              </div>

              <div className="agent-subcard p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "验证证据", "Verification evidence")}</p>
                    <p className="mt-2 text-[color:var(--color-text-secondary)]">
                      {summarizeSkillVerification(detail)} {locale === "zh"
                        ? "Friday 使用此证据来决定技能是否可以启用、需要修复还是应保持阻止。"
                        : "Friday uses this evidence to decide whether a skill is ready to enable, needs repair, or should stay blocked."}
                    </p>
                  </div>
                  {detail.verification ? (
                    <StatusPill tone={toneForPreflightVerdict(detail.verification.preflight.verdict)}>
                      {labelForPreflightVerdict(detail.verification.preflight.verdict, locale)}
                    </StatusPill>
                  ) : null}
                </div>
                {detail.verification ? (
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <SkillMetric label={localize(locale, "阻止项", "Blocking")} value={String(detail.verification.preflight.counts.blocking)} />
                      <SkillMetric label={localize(locale, "警告", "Warnings")} value={String(detail.verification.preflight.counts.warning)} />
                      <SkillMetric label={localize(locale, "建议", "Advisories")} value={String(detail.verification.preflight.counts.advisory)} />
                      <SkillMetric label={localize(locale, "验证时间", "Verified At")} value={formatTimestamp(detail.verification.verifiedAt)} />
                    </div>
                    <div className="grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
                      <p>{localize(locale, "清单判定", "Manifest verdict")}: {detail.verification.manifestVerdict.ok ? localize(locale, "通过", "ok") : localize(locale, "发现问题", "issues found")}</p>
                      <p>{localize(locale, "包完整性", "Package integrity")}: {detail.verification.packageIntegrity.available ? (detail.verification.packageIntegrity.ok ? localize(locale, "通过", "ok") : localize(locale, "不匹配", "mismatch")) : localize(locale, "不可用", "unavailable")}</p>
                      <p>{localize(locale, "运行时试运行", "Runtime dry-run")}: {detail.verification.runtimeDryRun.ok ? localize(locale, "通过", "ok") : localize(locale, "失败", "failed")}</p>
                      <p>{localize(locale, "信任", "Trust")}: {detail.verification.trustSummary.verdict}</p>
                    </div>
                    <div className="space-y-2">
                      {detail.verification.preflight.checks.map((check) => (
                        <div key={check.id} className="rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{check.label}</p>
                              <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">{check.summary}</p>
                            </div>
                            <StatusPill
                              tone={
                                check.level === "blocking"
                                  ? "danger"
                                  : check.level === "warning"
                                    ? "warning"
                                    : check.level === "advisory"
                                      ? "neutral"
                                      : "success"
                              }
                            >
                              {check.level}
                            </StatusPill>
                          </div>
                          {check.details.length > 0 ? (
                            <div className="mt-3 space-y-1 text-xs text-[color:var(--color-text-tertiary)]">
                              {check.details.map((line) => (
                                <p key={line}>{line}</p>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="agent-subcard p-4">
                  <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "版本", "Versions")}</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {detail.versions.length === 0 ? (
                      <p>{localize(locale, "暂无版本历史记录。", "No version history recorded yet.")}</p>
                    ) : (
                      detail.versions.map((version) => (
                        <p key={version.id}>
                          {version.version} · {localize(locale, "发布于", "released")} {formatTimestamp(version.releasedAt)}
                        </p>
                      ))
                    )}
                  </div>
                </div>
                <div className="agent-subcard p-4">
                  <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "安装记录", "Installations")}</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {detail.installations.length === 0 ? (
                      <p>{localize(locale, "暂无安装记录。", "No installation records yet.")}</p>
                    ) : (
                      detail.installations.map((installation) => (
                        <p key={installation.id}>
                          {installation.version} · {installation.status} · {localize(locale, "更新于", "updated")} {formatTimestamp(installation.updatedAt)}
                        </p>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="agent-subcard p-4">
                  <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "稳定化", "Stabilization")}</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    <p>{localize(locale, "路径", "Path")}: {describeStabilizationPath(detail, locale)}</p>
                    <p>{localize(locale, "推广阶段", "Promotion stage")}: {detail.originType === "generated" ? localize(locale, "草稿", "draft") : localize(locale, "已稳定", "stabilized")}</p>
                    <p>{localize(locale, "生命周期标签", "Lifecycle tags")}: {detail.tags.length > 0 ? detail.tags.join(", ") : localize(locale, "无", "none")}</p>
                    <p>
                      {localize(locale, "验证状态", "Verification state")}: {detail.verification ? (detail.verification.ok ? localize(locale, "证据通过", "evidence passed") : localize(locale, "需要修复", "needs repair")) : localize(locale, "未验证", "not verified")}
                    </p>
                  </div>
                </div>
                <div className="agent-subcard p-4">
                  <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "集成模式", "Integration Mode")}</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    <p>{localize(locale, "建议", "Recommendation")}: {describeIntegrationMode(detail, locale)}</p>
                    <p>
                      {localize(locale, "CLI 优先原因", "CLI-first reason")}: {isCliFirstSkill(detail)
                        ? localize(locale, "清单标签或生命周期来源已优先选择本地执行。", "Local execution is already preferred by manifest tags or lifecycle origin.")
                        : localize(locale, "暂无 CLI 优先生命周期信号。", "No CLI-first lifecycle signal yet.")}
                    </p>
                    <p>
                      {localize(locale, "MCP 适配", "MCP fit")}: {detail.originType === "mcp-backed"
                        ? localize(locale, "当远程/共享资源是合约的一部分时保留 MCP。", "Keep MCP when remote/shared resources are part of the contract.")
                        : localize(locale, "在添加更多 MCP 接口之前优先选择稳定技能或 CLI 路径。", "Prefer stable skill or CLI path before adding more MCP surface.")}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "Friday 已识别到此技能条目，但详细的生命周期记录仍在加载中。", "Friday has identified this skill entry, but the detailed lifecycle record is still loading.")}</p>
          )}
        </ShellCard>

        {!HIDE_MARKETPLACE_UI ? (
          <ShellCard
            eyebrow={localize(locale, "市场来源", "Marketplace Sources")}
            title={localize(locale, "信任与来源策略", "Trust and source policy")}
            aside={<StatusPill tone={sourcesQuery.data && sourcesQuery.data.length > 0 ? "success" : "neutral"}>{sourcesQuery.data?.length ?? 0} {localize(locale, "个已跟踪", "tracked")}</StatusPill>}
          >
            <div className="space-y-3">
              <div className="agent-subcard p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-2xl space-y-1">
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                      {localize(locale, "接入真实市场来源", "Connect a real marketplace source")}
                    </p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">
                      {localize(
                        locale,
                        "来源根地址下需要提供 `/index.json`。先把来源接上，再执行同步，Friday 才能看到真实可安装目录。",
                        "The source base URL must expose `/index.json`. Connect the source first, then run sync so Friday can see a real installable catalog.",
                      )}
                    </p>
                  </div>
                  <ActionButton
                    tone="secondary"
                    onClick={() => void syncSourceMutation.mutateAsync(undefined)}
                    disabled={syncSourceMutation.isPending || (sourcesQuery.data?.length ?? 0) === 0}
                  >
                    <RefreshCcw className="mr-2 h-4 w-4" />
                    {localize(locale, "同步全部来源", "Sync all sources")}
                  </ActionButton>
                </div>
                <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1.2fr_180px_auto]">
                  <div className="space-y-1">
                    <FieldLabel
                      label={localize(locale, "来源名称", "Source name")}
                      hint={localize(locale, "例如 Friday Official", "Example: Friday Official")}
                    />
                    <input
                      value={sourceNameInput}
                      onChange={(event) => setSourceNameInput(event.target.value)}
                      className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                      placeholder={localize(locale, "Friday Official", "Friday Official")}
                      data-testid="marketplace-source-name-input"
                    />
                  </div>
                  <div className="space-y-1">
                    <FieldLabel
                      label={localize(locale, "来源地址", "Source base URL")}
                      hint={localize(locale, "Friday 会自动请求 /index.json", "Friday will automatically request /index.json")}
                    />
                    <input
                      value={sourceBaseUrlInput}
                      onChange={(event) => setSourceBaseUrlInput(event.target.value)}
                      className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                      placeholder="https://..."
                      data-testid="marketplace-source-base-url-input"
                    />
                  </div>
                  <div className="space-y-1">
                    <FieldLabel
                      label={localize(locale, "信任策略", "Trust policy")}
                      hint={localize(locale, "默认先用 warn", "Start with warn by default")}
                    />
                    <select
                      value={sourceTrustPolicy}
                      onChange={(event) => setSourceTrustPolicy(event.target.value as "strict" | "warn" | "permissive")}
                      className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                      data-testid="marketplace-source-trust-policy-select"
                    >
                      <option value="warn">warn</option>
                      <option value="strict">strict</option>
                      <option value="permissive">permissive</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <ActionButton
                      onClick={() => void createSourceMutation.mutateAsync()}
                      disabled={!canCreateSource || createSourceMutation.isPending}
                      data-testid="marketplace-source-create-button"
                      className="w-full"
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {localize(locale, "新增来源", "Add source")}
                    </ActionButton>
                  </div>
                </div>
              </div>
              {(sourcesQuery.data ?? []).length === 0 ? (
                <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                  <p>{localize(locale, "暂未配置市场来源。", "No marketplace sources configured yet.")}</p>
                  <p className="text-xs text-[color:var(--color-text-tertiary)]">
                    {localize(
                      locale,
                      "这表示当前运行态的 /v1/marketplace/sources 真实返回为空，不代表内置技能或已安装技能不可用。",
                      "This means /v1/marketplace/sources is genuinely empty for the current runtime. It does not mean bundled or already installed skills are broken.",
                    )}
                  </p>
                </div>
              ) : (
                (sourcesQuery.data ?? []).map((source) => (
                  <div key={source.id} className="agent-subcard p-4 text-sm text-[color:var(--color-text-secondary)]">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{source.name}</p>
                        <p className="mt-1 text-[color:var(--color-text-secondary)]">{source.baseUrl}</p>
                      </div>
                      <StatusPill tone={source.enabled ? "success" : "warning"}>
                        {source.enabled ? localize(locale, "已启用", "enabled") : localize(locale, "已禁用", "disabled")}
                      </StatusPill>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
                      <p>{localize(locale, "信任策略", "Trust policy")}: {source.trustPolicy}</p>
                      <p>{localize(locale, "固定密钥", "Pinned keys")}: {source.pinnedKeyIds.length}</p>
                      <p>{localize(locale, "更新时间", "Updated")}: {formatTimestamp(source.updatedAt)}</p>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <ActionButton
                        tone="secondary"
                        onClick={() => void syncSourceMutation.mutateAsync(source.id)}
                        disabled={syncSourceMutation.isPending}
                      >
                        <RefreshCcw className="mr-2 h-4 w-4" />
                        {localize(locale, "同步", "Sync")}
                      </ActionButton>
                      <ActionButton
                        tone="secondary"
                        onClick={() => void toggleSourceMutation.mutateAsync({ sourceId: source.id, enabled: source.enabled })}
                        disabled={toggleSourceMutation.isPending}
                      >
                        <ShieldCheck className="mr-2 h-4 w-4" />
                        {source.enabled ? localize(locale, "禁用", "Disable") : localize(locale, "启用", "Enable")}
                      </ActionButton>
                      <ActionButton
                        tone="danger"
                        onClick={() => {
                          setDeleteConfirmSourceId(source.id);
                          setDeleteConfirmSourceName(source.name);
                        }}
                        disabled={deleteSourceMutation.isPending}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {localize(locale, "移除", "Remove")}
                      </ActionButton>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ShellCard>
        ) : null}
      </div>
      <ConfirmDialog
        open={deleteConfirmSkillId !== null}
        title={localize(locale, "确认删除技能", "Remove Skill")}
        description={localize(locale, "此操作不可撤销。技能将从本地注册中移除。", "This action cannot be undone. The skill will be removed from the local registry.")}
        confirmLabel={localize(locale, "删除", "Remove")}
        cancelLabel={localize(locale, "取消", "Cancel")}
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteConfirmSkillId) {
            void deleteMutation.mutateAsync(deleteConfirmSkillId).then(() => setDeleteConfirmSkillId(null));
          }
        }}
        onCancel={() => setDeleteConfirmSkillId(null)}
      />
      {!HIDE_MARKETPLACE_UI ? (
        <ConfirmDialog
          open={deleteConfirmSourceId !== null}
          title={localize(locale, "确认移除市场来源", "Remove Marketplace Source")}
          description={deleteConfirmSourceName
            ? localize(locale, `将移除来源 ${deleteConfirmSourceName}。已缓存的目录证据也会失去来源上下文。`, `Remove source ${deleteConfirmSourceName}. Cached catalog evidence will lose its source context.`)
            : localize(locale, "将移除当前市场来源。", "Remove the current marketplace source.")}
          confirmLabel={localize(locale, "移除来源", "Remove source")}
          cancelLabel={localize(locale, "取消", "Cancel")}
          tone="danger"
          loading={deleteSourceMutation.isPending}
          onConfirm={() => {
            if (deleteConfirmSourceId) {
              void deleteSourceMutation.mutateAsync(deleteConfirmSourceId);
            }
          }}
          onCancel={() => {
            setDeleteConfirmSourceId(null);
            setDeleteConfirmSourceName(null);
          }}
        />
      ) : null}
      <SkillImportWizard open={showImportWizard} onClose={() => setShowImportWizard(false)} />
      <SkillScannerPanel open={showScanner} onClose={() => setShowScanner(false)} />
    </div>
  );
}

function SkillMetric(props: { label: string; value: string }) {
  return (
    <div className="agent-metric-card">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{props.label}</p>
      <p className="mt-3 text-sm text-[color:var(--color-text-primary)]">{props.value}</p>
    </div>
  );
}
