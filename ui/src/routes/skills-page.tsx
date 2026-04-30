import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Package, RefreshCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ConfirmDialog, EmptyState, ShellCard, SkeletonCard, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { skillsApi } from "@/lib/api/skills";
import type { SkillLifecycleDetail, SkillLifecycleSummary } from "@/lib/api/types";

function formatTimestamp(value?: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function toneForStatus(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "installed" || status === "verified") return "success";
  if (status === "failed" || status === "error") return "danger";
  if (status === "installing" || status === "draft") return "warning";
  return "neutral";
}

function SkillRow(props: {
  skill: SkillLifecycleSummary;
  selected: boolean;
  onSelect: (skillId: string) => void;
}) {
  const { locale } = useAppLocale();
  const { skill } = props;
  return (
    <button
      type="button"
      className={`w-full rounded-[22px] border px-4 py-3 text-left transition ${
        props.selected
          ? "border-[color:var(--color-accent)] bg-[color:var(--color-bg-accent-subtle)]"
          : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] hover:bg-[color:var(--color-bg-subtle)]"
      }`}
      onClick={() => props.onSelect(skill.skillId)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[color:var(--color-text-primary)]">{skill.name}</p>
          <p className="mt-1 truncate text-xs text-[color:var(--color-text-tertiary)]">{skill.skillId}</p>
        </div>
        <StatusPill tone={toneForStatus(skill.status)}>{skill.status}</StatusPill>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
        {skill.description || localize(locale, "暂无描述", "No description yet")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <StatusPill tone="neutral">{skill.source}</StatusPill>
        <StatusPill tone={skill.registryLoaded ? "success" : "neutral"}>
          {skill.registryLoaded ? localize(locale, "已加载", "loaded") : localize(locale, "未加载", "not loaded")}
        </StatusPill>
      </div>
    </button>
  );
}

function SkillDetailPanel(props: {
  detail?: SkillLifecycleDetail;
  isLoading: boolean;
  onVerify: (skillId: string) => void;
  onDelete: (skillId: string) => void;
  verifying: boolean;
}) {
  const { locale } = useAppLocale();
  const { detail } = props;

  if (props.isLoading) {
    return <SkeletonCard lines={8} />;
  }
  if (!detail) {
    return (
      <EmptyState
        title={localize(locale, "选择一个能力包", "Select a skill")}
        description={localize(locale, "从左侧真实库存中选择一个能力包查看详情。", "Choose a skill from the live inventory on the left to inspect it.")}
      />
    );
  }

  const evidence = detail.verification;
  return (
    <ShellCard
      eyebrow={localize(locale, "能力详情", "Skill detail")}
      title={detail.name}
      aside={<StatusPill tone={toneForStatus(detail.status)}>{detail.status}</StatusPill>}
    >
      <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
        {detail.description || localize(locale, "暂无描述。", "No description yet.")}
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "来源", "Source")}</p>
          <p className="mt-1 text-sm text-[color:var(--color-text-primary)]">{detail.source}</p>
        </div>
        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "版本", "Version")}</p>
          <p className="mt-1 text-sm text-[color:var(--color-text-primary)]">{detail.installedVersion ?? detail.latestVersion ?? "-"}</p>
        </div>
        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "成熟度", "Maturity")}</p>
          <p className="mt-1 text-sm text-[color:var(--color-text-primary)]">{detail.maturity}</p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <ActionButton disabled={props.verifying} onClick={() => props.onVerify(detail.skillId)}>
          <BadgeCheck className="mr-2 h-4 w-4" />
          {localize(locale, "验证", "Verify")}
        </ActionButton>
        <ActionButton tone="danger" onClick={() => props.onDelete(detail.skillId)}>
          <Trash2 className="mr-2 h-4 w-4" />
          {localize(locale, "移除", "Remove")}
        </ActionButton>
        <Link className="agent-btn-secondary" to="/skills/generator">
          <Package className="mr-2 h-4 w-4" />
          {localize(locale, "生成新能力", "Generate skill")}
        </Link>
      </div>

      <div className="mt-5 rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{localize(locale, "验证证据", "Verification evidence")}</p>
        {evidence ? (
          <div className="mt-3 space-y-2 text-sm text-[color:var(--color-text-secondary)]">
            <p>{localize(locale, "结果", "Result")}: {evidence.ok ? localize(locale, "通过", "passed") : localize(locale, "未通过", "failed")}</p>
            <p>{localize(locale, "时间", "Time")}: {formatTimestamp(evidence.verifiedAt)}</p>
            <p>{localize(locale, "运行检查", "Runtime check")}: {evidence.runtimeDryRun.reason}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "这个能力包还没有最近验证证据。", "This skill has no recent verification evidence yet.")}
          </p>
        )}
      </div>
    </ShellCard>
  );
}

export function SkillsPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [deleteConfirmSkillId, setDeleteConfirmSkillId] = useState<string | null>(null);

  const skillsQuery = useQuery({
    queryKey: ["skills", "list"],
    queryFn: () => skillsApi.listSkills(),
    refetchInterval: 15_000,
  });

  const skills = skillsQuery.data ?? [];
  const selectedId = selectedSkillId ?? skills[0]?.skillId ?? null;

  const detailQuery = useQuery({
    queryKey: ["skills", "detail", selectedId],
    queryFn: () => skillsApi.getSkill(selectedId!),
    enabled: selectedId !== null,
    refetchInterval: 10_000,
  });

  const verifyMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.verifySkill(skillId),
    onSuccess: (_, skillId) => {
      toast.success(localize(locale, "技能验证完成", "Skill verification completed"));
      void queryClient.invalidateQueries({ queryKey: ["skills", "detail", skillId] });
      void queryClient.invalidateQueries({ queryKey: ["skills", "list"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "技能验证失败", "Skill verification failed"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.deleteSkill(skillId),
    onSuccess: (_, skillId) => {
      toast.success(locale === "zh" ? `已移除 ${skillId}` : `Removed ${skillId}`);
      setDeleteConfirmSkillId(null);
      if (selectedSkillId === skillId) setSelectedSkillId(null);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "技能移除失败", "Skill removal failed"));
    },
  });

  return (
    <div data-testid="skills-page" className="mx-auto grid max-w-7xl gap-5 px-6 py-10 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            {localize(locale, "能力包", "Skills")}
          </h1>
          <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "这里仅展示当前机器真实可加载、生成或本地管理的能力包。外部分发目录已从运行路径移除。",
              "This page only shows skills that are actually loadable, generated, or locally managed on this machine. External distribution catalog paths have been removed.",
            )}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <ShellCard>
            <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "库存", "Inventory")}</p>
            <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{String(skills.length)}</p>
          </ShellCard>
          <ShellCard>
            <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "已加载", "Loaded")}</p>
            <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{String(skills.filter((skill) => skill.registryLoaded).length)}</p>
          </ShellCard>
          <ShellCard>
            <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "需更新", "Updates")}</p>
            <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{String(skills.filter((skill) => skill.updateAvailable).length)}</p>
          </ShellCard>
        </div>

        <ShellCard
          eyebrow={localize(locale, "真实库存", "Live inventory")}
          title={localize(locale, "当前能力包", "Current skills")}
          aside={
            <ActionButton tone="secondary" onClick={() => void queryClient.invalidateQueries({ queryKey: ["skills"] })}>
              <RefreshCcw className="mr-2 h-4 w-4" />
              {localize(locale, "刷新", "Refresh")}
            </ActionButton>
          }
        >
          {skillsQuery.isLoading ? (
            <div className="space-y-3">
              <SkeletonCard lines={3} />
              <SkeletonCard lines={3} />
            </div>
          ) : skillsQuery.isError ? (
            <EmptyState
              title={localize(locale, "技能库存加载失败", "Failed to load skill inventory")}
              description={localize(locale, "这说明 /v1/skills 的真实链路有问题。", "This means the live /v1/skills path is broken.")}
            />
          ) : skills.length === 0 ? (
            <EmptyState
              title={localize(locale, "当前没有能力包", "No skills on this machine")}
              description={localize(locale, "库存为空会被直接展示，不再用演示目录填充。", "An empty inventory is shown directly instead of being padded with demo catalog data.")}
            />
          ) : (
            <div className="space-y-3">
              {skills.map((skill) => (
                <SkillRow
                  key={skill.skillId}
                  skill={skill}
                  selected={selectedId === skill.skillId}
                  onSelect={setSelectedSkillId}
                />
              ))}
            </div>
          )}
        </ShellCard>
      </div>

      <SkillDetailPanel
        detail={detailQuery.data}
        isLoading={detailQuery.isLoading}
        onVerify={(skillId) => verifyMutation.mutate(skillId)}
        onDelete={setDeleteConfirmSkillId}
        verifying={verifyMutation.isPending}
      />

      <ConfirmDialog
        open={deleteConfirmSkillId !== null}
        onCancel={() => setDeleteConfirmSkillId(null)}
        onConfirm={() => {
          if (deleteConfirmSkillId) deleteMutation.mutate(deleteConfirmSkillId);
        }}
        title={localize(locale, "确认移除能力包", "Remove skill")}
        description={localize(locale, "这会从当前机器移除该能力包记录和本地安装状态。", "This removes the skill record and local install state from this machine.")}
        confirmLabel={localize(locale, "移除", "Remove")}
        cancelLabel={localize(locale, "取消", "Cancel")}
        tone="danger"
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
