import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Download, Link2, Package, RefreshCcw, ShieldCheck, Trash2 } from "lucide-react";
import { DeepLinkPreviewDialog } from "@/components/deeplink/deeplink-preview-dialog";
import { toast } from "sonner";
import { ActionButton, ShellCard, SkeletonList, StatusPill } from "@/components/core/primitives";
import { HelpTooltip } from "@/components/core/help-tooltip";
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
}): string {
  if (input.originType === "cli-backed" || isCliFirstSkill(input)) {
    return "Prefer CLI-backed skill";
  }
  if (input.originType === "mcp-backed") {
    return "Prefer MCP-backed skill";
  }
  if (input.originType === "stabilized") {
    return "Prefer stable skill";
  }
  return "Prefer generated draft until verification proves it should be stabilized";
}

function describeStabilizationPath(input: {
  originType?: "generated" | "stabilized" | "cli-backed" | "mcp-backed";
  maturity?: "draft" | "verified" | "stable";
}): string {
  if (input.originType === "stabilized" || input.originType === "cli-backed" || input.originType === "mcp-backed") {
    return `generated -> ${input.originType} -> ${input.maturity ?? "draft"}`;
  }
  return `draft -> ${input.maturity ?? "draft"}`;
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
): string {
  if (verdict === "ready") return "ready";
  if (verdict === "needs_review") return "needs review";
  if (verdict === "blocked") return "blocked";
  return "unknown";
}

export function SkillsPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [recentGeneratorSessionId, setRecentGeneratorSessionId] = useState<string | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const requestedSkillId = searchParams.get("skillId");
  const requestedFocus = searchParams.get("focus");
  const focus: FridaySkillFocus =
    requestedFocus === "install" || requestedFocus === "verify" || requestedFocus === "sources"
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
    refetchInterval: 30_000,
  });

  const sourcesQuery = useQuery({
    queryKey: ["skills", "sources"],
    queryFn: () => skillsApi.listSources(),
    refetchInterval: 30_000,
  });

  const skills = skillsQuery.data ?? [];
  const catalog = catalogQuery.data?.items ?? [];
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
      toast.success("Skill verification completed");
      void queryClient.invalidateQueries({ queryKey: ["skills", "detail", skillId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Skill verification failed");
    },
  });

  const installMutation = useMutation({
    mutationFn: (skillId: string) => {
      const sourceId = catalog.find((item) => item.skillId === skillId)?.sourceId;
      return skillsApi.installSkill({ skillId, sourceId });
    },
    onSuccess: (result) => {
      toast.success(`Installed ${result.skill.name}`);
      setSelectedSkillId(result.skill.skillId);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Skill install failed");
    },
  });

  const updateMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.updateSkill(skillId),
    onSuccess: (result) => {
      toast.success(result.updated ? `Updated ${result.skill.name}` : `${result.skill.name} is already current`);
      setSelectedSkillId(result.skill.skillId);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Skill update failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.deleteSkill(skillId),
    onSuccess: (_, skillId) => {
      toast.success(`Removed ${skillId}`);
      if (selectedSkillId === skillId) {
        setSelectedSkillId(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Skill removal failed");
    },
  });

  const toggleSourceMutation = useMutation({
    mutationFn: (input: { sourceId: string; enabled: boolean }) =>
      input.enabled ? skillsApi.disableSource(input.sourceId) : skillsApi.enableSource(input.sourceId),
    onSuccess: () => {
      toast.success("Marketplace source updated");
      void queryClient.invalidateQueries({ queryKey: ["skills", "sources"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not update the source");
    },
  });

  const detail = detailQuery.data;
  const selectedCatalog = selectedSkillId
    ? catalog.find((item) => item.skillId === selectedSkillId) ?? null
    : null;

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
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setShowImportDialog(true)}
            data-testid="skills-import-button"
            className="inline-flex items-center gap-1.5 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1.5 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]"
          >
            <Link2 className="h-3.5 w-3.5" />
            Import from URL
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
          eyebrow="Generator"
          title="Package a skill from a guided session"
          aside={<StatusPill tone={recentGeneratorSessionId ? "success" : "neutral"}>{recentGeneratorSessionId ? "resume ready" : "new session"}</StatusPill>}
        >
          <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
            <p>
              Use the dedicated generator surface when you want clarification questions, draft generation, test evidence,
              and the final approve receipt in one place.
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
                Open generator
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
                  Resume last session
                </Link>
              ) : null}
            </div>
          </div>
        </ShellCard>

        <ShellCard
          eyebrow="Assistant Handoff"
          title="Install, verify, and repair skills without touching code"
          aside={
            selectedSkillId ? (
                <StatusPill tone={detail?.installedVersion || detail?.registryLoaded ? "success" : "warning"}>
                  {focus === "install"
                    ? "install focus"
                    : focus === "verify"
                      ? "verify focus"
                      : focus === "sources"
                        ? "source focus"
                        : detail?.installedVersion || detail?.registryLoaded
                          ? "actionable"
                          : "catalog only"}
                </StatusPill>
              ) : undefined
          }
        >
          {selectedSkillId ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <p>
                Friday uses this page as the operator detail view for a skill that Assistant has already recommended.
                The core lifecycle stays click-first: starter pack first, then managed installs, trust evidence, updates, and repair actions.
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                <SkillMetric label="Selected skill" value={detail?.name ?? selectedCatalog?.skillName ?? selectedSkillId} />
                <SkillMetric label="Lifecycle state" value={detail?.status ?? "catalog"} />
                <SkillMetric label="Origin" value={formatOriginType(detail?.originType ?? selectedCatalog?.originType, locale)} />
                <SkillMetric label="Maturity" value={formatMaturity(detail?.maturity ?? selectedCatalog?.maturity, locale)} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Pick a skill to see the next best install, verify, or repair action.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Bundled Starter Pack"
          title={<>Starter <HelpTooltip term="skill">skills</HelpTooltip> that ship with Friday</>}
          aside={<StatusPill tone={sections.starter.length > 0 ? "success" : "neutral"}>{sections.starter.length} bundled</StatusPill>}
        >
          <div className="space-y-3">
            {sections.starter.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">No bundled starter skills are visible yet.</p>
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
                      <StatusPill tone="success">starter</StatusPill>
                      <StatusPill tone={toneForSkillLifecycle(skill)}>{skill.status}</StatusPill>
                      <StatusPill>{formatOriginType(skill.originType, locale)}</StatusPill>
                      <StatusPill tone={toneForMaturity(skill.maturity)}>{formatMaturity(skill.maturity, locale)}</StatusPill>
                      {isCliFirstSkill(skill) ? <StatusPill tone="success">CLI-first</StatusPill> : null}
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    {skill.description || "Bundled starter skill."}
                  </p>
                </button>
              ))
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow="Installed / Managed"
          title={<>Choose the <HelpTooltip term="skill" /> Friday should manage</>}
          aside={<StatusPill tone={sections.installed.length > 0 ? "success" : "neutral"}>{sections.installed.length} managed</StatusPill>}
        >
          <div className="space-y-3">
            {sections.installed.length === 0 ? (
              <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <p>No managed skills yet. Friday can still use the bundled starter pack immediately.</p>
                <p>Tell Friday what you want to automate and it will create or install the right skill.</p>
                <Link to="/chat" className="inline-flex items-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)]">Ask Friday in Chat</Link>
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
                        {skill.updateAvailable ? "update available" : skill.status}
                      </StatusPill>
                      <StatusPill>{formatOriginType(skill.originType, locale)}</StatusPill>
                      <StatusPill tone={toneForMaturity(skill.maturity)}>{formatMaturity(skill.maturity, locale)}</StatusPill>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    {skill.description || "No description available."}
                  </p>
                  {isCliFirstSkill(skill) ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">
                      CLI-first: this skill is already shaped to prefer direct local execution over heavier tool bridges.
                    </p>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow="Updates"
          title="Skills that need attention"
          aside={<StatusPill tone={sections.updates.length > 0 ? "warning" : "success"}>{sections.updates.length} pending</StatusPill>}
        >
          <div className="space-y-3">
            {sections.updates.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">All installed skills are at the latest tracked version.</p>
            ) : (
              sections.updates.map((skill) => (
                <div key={skill.skillId} className="agent-subcard p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{skill.name}</p>
                      <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
                        Installed {skill.installedVersion ?? "unknown"} · Latest {skill.latestVersion ?? "unknown"}
                      </p>
                    </div>
                    <ActionButton
                      onClick={() => void updateMutation.mutateAsync(skill.skillId)}
                      disabled={updateMutation.isPending}
                    >
                      <RefreshCcw className="mr-2 h-4 w-4" />
                      Update
                    </ActionButton>
                  </div>
                </div>
              ))
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow="Marketplace"
          title="New skills you can install"
          aside={<StatusPill tone={sections.available.length > 0 ? "neutral" : "success"}>{sections.available.length} discoverable</StatusPill>}
        >
          <div className="space-y-3">
            {sections.available.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">Friday does not currently see any catalog entries beyond the installed set.</p>
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
                        trust {item.trustScore}
                      </StatusPill>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    Version {item.version} · {item.publisher ?? "Unknown publisher"}
                  </p>
                  {item.recommendedNextAction ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">
                      {item.recommendedNextAction}
                    </p>
                  ) : null}
                  {item.blockedReasons && item.blockedReasons.length > 0 ? (
                    <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                      Blocked: {item.blockedReasons[0]}
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
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow="Skill Detail"
          title={detail?.name ?? selectedCatalog?.skillName ?? "Select a skill"}
          aside={
            detail ? (
              <StatusPill tone={toneForSkillLifecycle(detail)}>
                {detail.updateAvailable ? "update available" : detail.status}
              </StatusPill>
            ) : undefined
          }
        >
          {!selectedSkillId ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Select an installed skill or catalog item to inspect lifecycle evidence.</p>
          ) : detail ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <div className="agent-subcard p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{detail.name}</p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{detail.skillId}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {detail.starter ? <StatusPill tone="success">starter pack</StatusPill> : null}
                    <StatusPill tone={toneForSkillLifecycle(detail)}>
                      {detail.installedVersion ?? detail.latestVersion ?? "unversioned"}
                    </StatusPill>
                    <StatusPill>{formatOriginType(detail.originType, locale)}</StatusPill>
                    <StatusPill tone={toneForMaturity(detail.maturity)}>{formatMaturity(detail.maturity, locale)}</StatusPill>
                    {isCliFirstSkill(detail) ? <StatusPill tone="success">CLI-first</StatusPill> : null}
                  </div>
                </div>
                <p className="mt-3 text-[color:var(--color-text-secondary)]">
                  {detail.description || "No description recorded for this skill."}
                </p>
                <div className="mt-4 grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
                  <p>Source: {detail.source}</p>
                  <p>Origin: {detail.origin}</p>
                  <p>Publisher: {detail.publisher ?? "Unknown"}</p>
                  <p>Source trust: {detail.sourceDetails?.trustPolicy ?? "local"}</p>
                  <p>Trust tier: {detail.catalogEntry?.trustTier ?? "local"}</p>
                  <p>Installed version: {detail.installedVersion ?? "not installed"}</p>
                  <p>Latest version: {detail.latestVersion ?? "unknown"}</p>
                  <p>Starter pack: {detail.starter ? "yes" : "no"}</p>
                  <p>{localize(locale, "来源类型", "Origin type")}: {formatOriginType(detail.originType, locale)}</p>
                  <p>{localize(locale, "成熟度", "Maturity")}: {formatMaturity(detail.maturity, locale)}</p>
                  <p>Implementation status: {detail.catalogEntry?.implementationStatus ?? "installed"}</p>
                </div>
                {detail.catalogEntry?.recommendedNextAction ? (
                  <div className="mt-4 rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 text-sm text-[color:var(--color-text-secondary)]">
                    <p className="font-medium text-[color:var(--color-text-primary)]">Next best action</p>
                    <p className="mt-2">{detail.catalogEntry.recommendedNextAction}</p>
                    {detail.catalogEntry.blockedReasons && detail.catalogEntry.blockedReasons.length > 0 ? (
                      <div className="mt-3 space-y-1 text-xs text-[color:var(--color-text-tertiary)]">
                        {detail.catalogEntry.blockedReasons.map((reason) => (
                          <p key={reason}>Blocked: {reason}</p>
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
                  {detail.installedVersion ? (
                    <ActionButton
                      onClick={() => void verifyMutation.mutateAsync(detail.skillId)}
                      disabled={verifyMutation.isPending}
                    >
                      <BadgeCheck className="mr-2 h-4 w-4" />
                      Verify
                    </ActionButton>
                  ) : (
                    <ActionButton
                      onClick={() => void installMutation.mutateAsync(detail.skillId)}
                      disabled={installMutation.isPending}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Install
                    </ActionButton>
                  )}
                  {detail.updateAvailable ? (
                    <ActionButton
                      tone="secondary"
                      onClick={() => void updateMutation.mutateAsync(detail.skillId)}
                      disabled={updateMutation.isPending}
                    >
                      <RefreshCcw className="mr-2 h-4 w-4" />
                      Update
                    </ActionButton>
                  ) : null}
                  {!detail.starter && (detail.installedVersion || detail.registryLoaded) ? (
                    <ActionButton
                      tone="danger"
                      onClick={() => void deleteMutation.mutateAsync(detail.skillId)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove
                    </ActionButton>
                  ) : null}
                  <Link
                    className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildObservabilityHref({ focus: "assistant" })}
                  >
                    Open diagnostics
                  </Link>
                </div>
              </div>

              <div className="agent-subcard p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">Verification evidence</p>
                    <p className="mt-2 text-[color:var(--color-text-secondary)]">
                      {summarizeSkillVerification(detail)} Friday uses this evidence to decide whether a skill is ready to
                      enable, needs repair, or should stay blocked.
                    </p>
                  </div>
                  {detail.verification ? (
                    <StatusPill tone={toneForPreflightVerdict(detail.verification.preflight.verdict)}>
                      {labelForPreflightVerdict(detail.verification.preflight.verdict)}
                    </StatusPill>
                  ) : null}
                </div>
                {detail.verification ? (
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <SkillMetric label="Blocking" value={String(detail.verification.preflight.counts.blocking)} />
                      <SkillMetric label="Warnings" value={String(detail.verification.preflight.counts.warning)} />
                      <SkillMetric label="Advisories" value={String(detail.verification.preflight.counts.advisory)} />
                      <SkillMetric label="Verified At" value={formatTimestamp(detail.verification.verifiedAt)} />
                    </div>
                    <div className="grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
                      <p>Manifest verdict: {detail.verification.manifestVerdict.ok ? "ok" : "issues found"}</p>
                      <p>Package integrity: {detail.verification.packageIntegrity.available ? (detail.verification.packageIntegrity.ok ? "ok" : "mismatch") : "unavailable"}</p>
                      <p>Runtime dry-run: {detail.verification.runtimeDryRun.ok ? "ok" : "failed"}</p>
                      <p>Trust: {detail.verification.trustSummary.verdict}</p>
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
                  <p className="font-medium text-[color:var(--color-text-primary)]">Versions</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {detail.versions.length === 0 ? (
                      <p>No version history recorded yet.</p>
                    ) : (
                      detail.versions.map((version) => (
                        <p key={version.id}>
                          {version.version} · released {formatTimestamp(version.releasedAt)}
                        </p>
                      ))
                    )}
                  </div>
                </div>
                <div className="agent-subcard p-4">
                  <p className="font-medium text-[color:var(--color-text-primary)]">Installations</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {detail.installations.length === 0 ? (
                      <p>No installation records yet.</p>
                    ) : (
                      detail.installations.map((installation) => (
                        <p key={installation.id}>
                          {installation.version} · {installation.status} · updated {formatTimestamp(installation.updatedAt)}
                        </p>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="agent-subcard p-4">
                  <p className="font-medium text-[color:var(--color-text-primary)]">Stabilization</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    <p>Path: {describeStabilizationPath(detail)}</p>
                    <p>Promotion stage: {detail.originType === "generated" ? "draft" : "stabilized"}</p>
                    <p>Lifecycle tags: {detail.tags.length > 0 ? detail.tags.join(", ") : "none"}</p>
                    <p>
                      Verification state: {detail.verification ? (detail.verification.ok ? "evidence passed" : "needs repair") : "not verified"}
                    </p>
                  </div>
                </div>
                <div className="agent-subcard p-4">
                  <p className="font-medium text-[color:var(--color-text-primary)]">Integration Mode</p>
                  <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-tertiary)]">
                    <p>Recommendation: {describeIntegrationMode(detail)}</p>
                    <p>
                      CLI-first reason: {isCliFirstSkill(detail)
                        ? "Local execution is already preferred by manifest tags or lifecycle origin."
                        : "No CLI-first lifecycle signal yet."}
                    </p>
                    <p>
                      MCP fit: {detail.originType === "mcp-backed"
                        ? "Keep MCP when remote/shared resources are part of the contract."
                        : "Prefer stable skill or CLI path before adding more MCP surface."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Friday knows about this skill from the catalog, but the detailed lifecycle record is still loading.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Marketplace Sources"
          title="Trust and source policy"
          aside={<StatusPill tone={sourcesQuery.data && sourcesQuery.data.length > 0 ? "success" : "neutral"}>{sourcesQuery.data?.length ?? 0} tracked</StatusPill>}
        >
          <div className="space-y-3">
            {(sourcesQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">No marketplace sources configured yet.</p>
            ) : (
              (sourcesQuery.data ?? []).map((source) => (
                <div key={source.id} className="agent-subcard p-4 text-sm text-[color:var(--color-text-secondary)]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{source.name}</p>
                      <p className="mt-1 text-[color:var(--color-text-secondary)]">{source.baseUrl}</p>
                    </div>
                    <StatusPill tone={source.enabled ? "success" : "warning"}>
                      {source.enabled ? "enabled" : "disabled"}
                    </StatusPill>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
                    <p>Trust policy: {source.trustPolicy}</p>
                    <p>Pinned keys: {source.pinnedKeyIds.length}</p>
                    <p>Updated: {formatTimestamp(source.updatedAt)}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <ActionButton
                      tone="secondary"
                      onClick={() => void toggleSourceMutation.mutateAsync({ sourceId: source.id, enabled: source.enabled })}
                      disabled={toggleSourceMutation.isPending}
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {source.enabled ? "Disable" : "Enable"}
                    </ActionButton>
                  </div>
                </div>
              ))
            )}
          </div>
        </ShellCard>
      </div>
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
