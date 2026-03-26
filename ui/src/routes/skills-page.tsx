import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Download, Package, RefreshCcw, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { skillsApi } from "@/lib/api/skills";
import { buildObservabilityHref } from "@/lib/observability/view-models";
import { trackStarterSkillBatch, trackStarterSkillEvent } from "@/lib/skills/starter-skill-telemetry";
import {
  buildSkillHref,
  buildSkillOperatorSections,
  chooseInitialSkillId,
  summarizeSkillVerification,
  toneForSkillLifecycle,
  type FridaySkillFocus,
} from "@/lib/skills/view-models";

function formatTimestamp(value?: string): string {
  if (!value) return "Unknown";
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

function formatOriginType(originType?: "generated" | "stabilized" | "cli-backed" | "mcp-backed"): string {
  if (originType === "cli-backed") return "CLI-backed";
  if (originType === "mcp-backed") return "MCP-backed";
  if (originType === "stabilized") return "Stabilized";
  return "Generated";
}

function formatMaturity(maturity?: "draft" | "verified" | "stable"): string {
  if (maturity === "stable") return "Stable";
  if (maturity === "verified") return "Verified";
  return "Draft";
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

export function SkillsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
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
    <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-4">
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
            <div className="space-y-4 text-sm text-white/70">
              <p>
                Friday uses this page as the operator detail view for a skill that Assistant has already recommended.
                The core lifecycle stays click-first: starter pack first, then managed installs, trust evidence, updates, and repair actions.
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                <SkillMetric label="Selected skill" value={detail?.name ?? selectedCatalog?.skillName ?? selectedSkillId} />
                <SkillMetric label="Lifecycle state" value={detail?.status ?? "catalog"} />
                <SkillMetric label="Origin" value={formatOriginType(detail?.originType ?? selectedCatalog?.originType)} />
                <SkillMetric label="Maturity" value={formatMaturity(detail?.maturity ?? selectedCatalog?.maturity)} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/60">Pick a skill to see the next best install, verify, or repair action.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Bundled Starter Pack"
          title="Starter skills that ship with Friday"
          aside={<StatusPill tone={sections.starter.length > 0 ? "success" : "neutral"}>{sections.starter.length} bundled</StatusPill>}
        >
          <div className="space-y-3">
            {sections.starter.length === 0 ? (
              <p className="text-sm text-white/60">No bundled starter skills are visible yet.</p>
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
                      <p className="font-medium text-white">{skill.name}</p>
                      <p className="text-xs text-white/50">{skill.skillId}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill tone="success">starter</StatusPill>
                      <StatusPill tone={toneForSkillLifecycle(skill)}>{skill.status}</StatusPill>
                      <StatusPill>{formatOriginType(skill.originType)}</StatusPill>
                      <StatusPill tone={toneForMaturity(skill.maturity)}>{formatMaturity(skill.maturity)}</StatusPill>
                      {isCliFirstSkill(skill) ? <StatusPill tone="success">CLI-first</StatusPill> : null}
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-white/60">
                    {skill.description || "Bundled starter skill."}
                  </p>
                </button>
              ))
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow="Installed / Managed"
          title="Choose the skill Friday should manage"
          aside={<StatusPill tone={sections.installed.length > 0 ? "success" : "neutral"}>{sections.installed.length} managed</StatusPill>}
        >
          <div className="space-y-3">
            {sections.installed.length === 0 ? (
              <p className="text-sm text-white/60">No managed skills yet. Friday can still use the bundled starter pack immediately.</p>
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
                      <p className="font-medium text-white">{skill.name}</p>
                      <p className="text-xs text-white/50">{skill.skillId}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill tone={toneForSkillLifecycle(skill)}>
                        {skill.updateAvailable ? "update available" : skill.status}
                      </StatusPill>
                      <StatusPill>{formatOriginType(skill.originType)}</StatusPill>
                      <StatusPill tone={toneForMaturity(skill.maturity)}>{formatMaturity(skill.maturity)}</StatusPill>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-white/60">
                    {skill.description || "No description available."}
                  </p>
                  {isCliFirstSkill(skill) ? (
                    <p className="mt-2 text-xs text-emerald-100/75">
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
              <p className="text-sm text-white/60">All installed skills are at the latest tracked version.</p>
            ) : (
              sections.updates.map((skill) => (
                <div key={skill.skillId} className="agent-subcard p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-white">{skill.name}</p>
                      <p className="mt-1 text-sm text-white/60">
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
          aside={<StatusPill tone={sections.available.length > 0 ? "neutral" : "success"}>{sections.available.length} installable</StatusPill>}
        >
          <div className="space-y-3">
            {sections.available.length === 0 ? (
              <p className="text-sm text-white/60">Friday does not currently see any catalog entries beyond the installed set.</p>
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
                      <p className="font-medium text-white">{item.skillName}</p>
                      <p className="text-xs text-white/50">{item.skillId}</p>
                    </div>
                    <StatusPill tone={item.signatureValid ? "success" : "warning"}>
                      trust {item.trustScore}
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-white/60">
                    Version {item.version} · {item.publisher ?? "Unknown publisher"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.originType ? <StatusPill>{formatOriginType(item.originType)}</StatusPill> : null}
                    {item.maturity ? (
                      <StatusPill tone={toneForMaturity(item.maturity)}>{formatMaturity(item.maturity)}</StatusPill>
                    ) : null}
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
            <p className="text-sm text-white/60">Select an installed skill or catalog item to inspect lifecycle evidence.</p>
          ) : detail ? (
            <div className="space-y-4 text-sm text-white/75">
              <div className="agent-subcard p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">{detail.name}</p>
                    <p className="text-xs text-white/50">{detail.skillId}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {detail.starter ? <StatusPill tone="success">starter pack</StatusPill> : null}
                    <StatusPill tone={toneForSkillLifecycle(detail)}>
                      {detail.installedVersion ?? detail.latestVersion ?? "unversioned"}
                    </StatusPill>
                    <StatusPill>{formatOriginType(detail.originType)}</StatusPill>
                    <StatusPill tone={toneForMaturity(detail.maturity)}>{formatMaturity(detail.maturity)}</StatusPill>
                    {isCliFirstSkill(detail) ? <StatusPill tone="success">CLI-first</StatusPill> : null}
                  </div>
                </div>
                <p className="mt-3 text-white/60">
                  {detail.description || "No description recorded for this skill."}
                </p>
                <div className="mt-4 grid gap-2 text-xs text-white/55">
                  <p>Source: {detail.source}</p>
                  <p>Origin: {detail.origin}</p>
                  <p>Publisher: {detail.publisher ?? "Unknown"}</p>
                  <p>Source trust: {detail.sourceDetails?.trustPolicy ?? "local"}</p>
                  <p>Installed version: {detail.installedVersion ?? "not installed"}</p>
                  <p>Latest version: {detail.latestVersion ?? "unknown"}</p>
                  <p>Starter pack: {detail.starter ? "yes" : "no"}</p>
                  <p>Origin type: {formatOriginType(detail.originType)}</p>
                  <p>Maturity: {formatMaturity(detail.maturity)}</p>
                </div>
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
                    className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                    to={buildObservabilityHref({ focus: "assistant" })}
                  >
                    Open diagnostics
                  </Link>
                </div>
              </div>

              <div className="agent-subcard p-4">
                <p className="font-medium text-white">Verification evidence</p>
                <p className="mt-2 text-white/60">
                  {summarizeSkillVerification(detail)} Friday uses this evidence to decide whether a skill is ready to
                  enable, needs repair, or should stay blocked.
                </p>
                {detail.verification ? (
                  <div className="mt-4 grid gap-2 text-xs text-white/55">
                    <p>Manifest verdict: {detail.verification.manifestVerdict.ok ? "ok" : "issues found"}</p>
                    <p>Package integrity: {detail.verification.packageIntegrity.available ? (detail.verification.packageIntegrity.ok ? "ok" : "mismatch") : "unavailable"}</p>
                    <p>Runtime dry-run: {detail.verification.runtimeDryRun.ok ? "ok" : "failed"}</p>
                    <p>Trust: {detail.verification.trustSummary.verdict}</p>
                    <p>Verified at: {formatTimestamp(detail.verification.verifiedAt)}</p>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="agent-subcard p-4">
                  <p className="font-medium text-white">Versions</p>
                  <div className="mt-3 space-y-2 text-xs text-white/55">
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
                  <p className="font-medium text-white">Installations</p>
                  <div className="mt-3 space-y-2 text-xs text-white/55">
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
                  <p className="font-medium text-white">Stabilization</p>
                  <div className="mt-3 space-y-2 text-xs text-white/55">
                    <p>Path: {describeStabilizationPath(detail)}</p>
                    <p>Promotion stage: {detail.originType === "generated" ? "draft" : "stabilized"}</p>
                    <p>Lifecycle tags: {detail.tags.length > 0 ? detail.tags.join(", ") : "none"}</p>
                    <p>
                      Verification state: {detail.verification ? (detail.verification.ok ? "evidence passed" : "needs repair") : "not verified"}
                    </p>
                  </div>
                </div>
                <div className="agent-subcard p-4">
                  <p className="font-medium text-white">Integration Mode</p>
                  <div className="mt-3 space-y-2 text-xs text-white/55">
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
            <p className="text-sm text-white/60">Friday knows about this skill from the catalog, but the detailed lifecycle record is still loading.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Marketplace Sources"
          title="Trust and source policy"
          aside={<StatusPill tone={sourcesQuery.data && sourcesQuery.data.length > 0 ? "success" : "neutral"}>{sourcesQuery.data?.length ?? 0} tracked</StatusPill>}
        >
          <div className="space-y-3">
            {(sourcesQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-white/60">No marketplace sources configured yet.</p>
            ) : (
              (sourcesQuery.data ?? []).map((source) => (
                <div key={source.id} className="agent-subcard p-4 text-sm text-white/75">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-white">{source.name}</p>
                      <p className="mt-1 text-white/60">{source.baseUrl}</p>
                    </div>
                    <StatusPill tone={source.enabled ? "success" : "warning"}>
                      {source.enabled ? "enabled" : "disabled"}
                    </StatusPill>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-white/55">
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
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">{props.label}</p>
      <p className="mt-3 text-sm text-white">{props.value}</p>
    </div>
  );
}
