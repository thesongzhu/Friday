import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, FlaskConical, RefreshCcw, SkipForward, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, EmptyState, ShellCard, SkeletonList, StatusPill } from "@/components/core/primitives";
import { reflexApi, type ReflexCandidate, type ReflexCandidateKind, type ReflexCandidateStatus } from "@/lib/api/reflex";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

type ReflexTab = "review" | "onboarding" | "preferences";

const REFLEX_QUERY_KEY = ["reflex"] as const;

const CANDIDATE_STATUSES: Array<{ value: ReflexCandidateStatus; labelZh: string; labelEn: string }> = [
  { value: "ready_for_review", labelZh: "待审核", labelEn: "Needs Review" },
  { value: "proposed", labelZh: "已提出", labelEn: "Proposed" },
  { value: "testing", labelZh: "测试中", labelEn: "Testing" },
  { value: "failed", labelZh: "失败", labelEn: "Failed" },
  { value: "approved", labelZh: "已批准", labelEn: "Approved" },
  { value: "rejected", labelZh: "已拒绝", labelEn: "Rejected" },
  { value: "dismissed", labelZh: "已忽略", labelEn: "Dismissed" },
  { value: "superseded", labelZh: "已替代", labelEn: "Superseded" },
];

function candidateTone(status: ReflexCandidateStatus): "neutral" | "success" | "warning" | "danger" {
  if (status === "approved") return "success";
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "ready_for_review" || status === "testing") return "warning";
  return "neutral";
}

function kindLabel(kind: ReflexCandidateKind, locale: "zh" | "en"): string {
  const zh: Record<ReflexCandidateKind, string> = {
    memory: "记忆",
    preference: "偏好",
    recipe: "流程",
    skill: "技能",
    workflow: "工作流",
    fix: "修复",
    test_policy: "测试策略",
  };
  const en: Record<ReflexCandidateKind, string> = {
    memory: "Memory",
    preference: "Preference",
    recipe: "Recipe",
    skill: "Skill",
    workflow: "Workflow",
    fix: "Fix",
    test_policy: "Test Policy",
  };
  return locale === "zh" ? zh[kind] : en[kind];
}

function formatTime(value?: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function compactJson(value: Record<string, unknown>): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > 520 ? `${text.slice(0, 520)}\n...` : text;
}

function statusLabel(status: ReflexCandidateStatus, locale: "zh" | "en"): string {
  const match = CANDIDATE_STATUSES.find((item) => item.value === status);
  return match ? localize(locale, match.labelZh, match.labelEn) : status;
}

function metadataValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function candidateSourceSummary(candidate: ReflexCandidate, locale: "zh" | "en"): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [
    { label: localize(locale, "来源", "Origin"), value: candidate.origin },
    { label: localize(locale, "风险", "Risk"), value: String(candidate.riskTier) },
    { label: localize(locale, "置信度", "Confidence"), value: `${Math.round(candidate.confidence * 100)}%` },
  ];
  if (candidate.sourceRunId) items.push({ label: "Run", value: candidate.sourceRunId });
  if (candidate.channelKind) items.push({ label: localize(locale, "渠道", "Channel"), value: candidate.channelKind });
  if (candidate.sessionKey) items.push({ label: "Session", value: candidate.sessionKey });
  if (candidate.decidedAt) items.push({ label: localize(locale, "决定于", "Decided"), value: formatTime(candidate.decidedAt) });
  return items;
}

function candidateImpact(candidate: ReflexCandidate, locale: "zh" | "en"): string {
  if (candidate.kind === "preference") {
    const category = metadataValue(candidate.payload.category);
    const key = metadataValue(candidate.payload.key);
    return category && key
      ? `${category}/${key}`
      : localize(locale, "会影响 canonical preference", "Affects canonical preference");
  }
  if (candidate.kind === "skill") {
    return localize(locale, "批准后才会保存并启用新 skill", "Saved and enabled only after approval");
  }
  if (candidate.kind === "workflow") {
    return localize(locale, "批准后才会保存或发布 workflow", "Saved or published only after approval");
  }
  if (candidate.kind === "fix") {
    const toolName = metadataValue(candidate.payload.toolName);
    return toolName
      ? localize(locale, `修复 ${toolName} 的失败路径`, `Fixes failure path for ${toolName}`)
      : localize(locale, "批准前不会执行真实修复", "No real fix runs before approval");
  }
  if (candidate.kind === "recipe") {
    return localize(locale, "批准后写入 recipe memory", "Approval writes recipe memory");
  }
  if (candidate.kind === "memory") {
    return localize(locale, "批准后写入长期记忆", "Approval writes long-term memory");
  }
  return localize(locale, "批准后更新测试策略", "Approval updates test policy");
}

function candidateTestSummary(candidate: ReflexCandidate, locale: "zh" | "en"): string {
  const completed = metadataValue(candidate.evidence.testCompletedAt);
  const failed = metadataValue(candidate.evidence.testFailedAt);
  const draftSkill = metadataValue(candidate.evidence.draftSkillId);
  const draftWorkflow = metadataValue(candidate.evidence.draftWorkflowId);
  if (failed) return localize(locale, `测试失败：${failed}`, `Test failed: ${failed}`);
  if (draftSkill) return localize(locale, `已测试 skill 草稿 ${draftSkill}`, `Tested skill draft ${draftSkill}`);
  if (draftWorkflow) return localize(locale, `已测试 workflow 草稿 ${draftWorkflow}`, `Tested workflow draft ${draftWorkflow}`);
  if (completed) return localize(locale, `已完成 deterministic test：${completed}`, `Deterministic test completed: ${completed}`);
  return localize(locale, "尚未测试", "Not tested yet");
}

function ReflexCandidateCard(props: {
  candidate: ReflexCandidate;
  isPending: boolean;
  onTest: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { locale } = useAppLocale();
  const canReview = props.candidate.status === "ready_for_review"
    || props.candidate.status === "proposed"
    || props.candidate.status === "failed";

  return (
    <article className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={candidateTone(props.candidate.status)}>
              {statusLabel(props.candidate.status, locale)}
            </StatusPill>
            <StatusPill>{kindLabel(props.candidate.kind, locale)}</StatusPill>
            <span className="text-xs text-[color:var(--color-text-faint)]">
              {localize(locale, "更新于", "Updated")} {formatTime(props.candidate.updatedAt)}
            </span>
          </div>
          <h3 className="mt-3 text-base font-semibold text-[color:var(--color-text-primary)]">
            {props.candidate.title}
          </h3>
          <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {props.candidate.summary}
          </p>
          <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-secondary)] sm:grid-cols-2 lg:grid-cols-3">
            {candidateSourceSummary(props.candidate, locale).map((item) => (
              <div key={`${item.label}:${item.value}`} className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
                <span className="block font-medium text-[color:var(--color-text-faint)]">{item.label}</span>
                <span className="mt-1 block truncate text-[color:var(--color-text-secondary)]" title={item.value}>{item.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-secondary)] md:grid-cols-2">
            <p className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
              <span className="font-medium text-[color:var(--color-text-faint)]">{localize(locale, "影响", "Impact")}: </span>
              {candidateImpact(props.candidate, locale)}
            </p>
            <p className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
              <span className="font-medium text-[color:var(--color-text-faint)]">{localize(locale, "测试", "Test")}: </span>
              {candidateTestSummary(props.candidate, locale)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          <ActionButton
            tone="secondary"
            className="!min-h-[36px] !px-3 !text-xs"
            disabled={props.isPending}
            onClick={() => props.onTest(props.candidate.id)}
          >
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {localize(locale, "测试", "Test")}
          </ActionButton>
          {canReview ? (
            <>
              <ActionButton
                className="!min-h-[36px] !px-3 !text-xs"
                disabled={props.isPending}
                onClick={() => props.onApprove(props.candidate.id)}
              >
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {localize(locale, "批准", "Approve")}
              </ActionButton>
              <ActionButton
                tone="danger"
                className="!min-h-[36px] !px-3 !text-xs"
                disabled={props.isPending}
                onClick={() => props.onReject(props.candidate.id)}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {localize(locale, "拒绝", "Reject")}
              </ActionButton>
              <ActionButton
                tone="secondary"
                className="!min-h-[36px] !px-3 !text-xs"
                disabled={props.isPending}
                onClick={() => props.onDismiss(props.candidate.id)}
              >
                {localize(locale, "忽略", "Dismiss")}
              </ActionButton>
            </>
          ) : null}
        </div>
      </div>
      <details className="mt-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-[color:var(--color-text-secondary)]">
          {localize(locale, "查看 payload 和证据", "View payload and evidence")}
        </summary>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <pre className="overflow-auto rounded-xl bg-[color:var(--color-bg-contrast)] p-3 text-xs text-[color:var(--color-text-secondary)]">
            {compactJson(props.candidate.payload)}
          </pre>
          <pre className="overflow-auto rounded-xl bg-[color:var(--color-bg-contrast)] p-3 text-xs text-[color:var(--color-text-secondary)]">
            {compactJson(props.candidate.evidence)}
          </pre>
        </div>
      </details>
    </article>
  );
}

export function ReflexPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ReflexTab>("review");
  const [status, setStatus] = useState<ReflexCandidateStatus>("ready_for_review");
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [busyPreferenceId, setBusyPreferenceId] = useState<string | null>(null);

  const onboardingQuery = useQuery({
    queryKey: [...REFLEX_QUERY_KEY, "onboarding"],
    queryFn: () => reflexApi.getOnboarding(),
  });

  const candidatesQuery = useQuery({
    queryKey: [...REFLEX_QUERY_KEY, "candidates", status],
    queryFn: () => reflexApi.listCandidates({ status, limit: 100 }),
  });

  const preferencesQuery = useQuery({
    queryKey: [...REFLEX_QUERY_KEY, "preferences"],
    queryFn: () => reflexApi.listPreferences(),
  });

  const invalidateReflex = async () => {
    await queryClient.invalidateQueries({ queryKey: REFLEX_QUERY_KEY });
  };

  const startOnboardingMutation = useMutation({
    mutationFn: () => reflexApi.startOnboarding(),
    onSuccess: async () => {
      toast.success(localize(locale, "Reflex 引导已开始", "Reflex onboarding started"));
      await invalidateReflex();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : localize(locale, "启动失败", "Failed to start")),
  });

  const answerMutation = useMutation({
    mutationFn: (input: { questionId: string; value: string }) =>
      reflexApi.answerOnboarding({
        questionId: input.questionId,
        answer: { value: input.value },
        sourceSurface: "review_center",
      }),
    onSuccess: async () => {
      await invalidateReflex();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : localize(locale, "保存回答失败", "Failed to save answer")),
  });

  const skipMutation = useMutation({
    mutationFn: (questionId: string) => reflexApi.skipOnboarding({ questionId, sourceSurface: "review_center" }),
    onSuccess: async () => {
      await invalidateReflex();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : localize(locale, "跳过失败", "Failed to skip")),
  });

  const candidateMutation = useMutation({
    mutationFn: async (input: { id: string; action: "test" | "approve" | "reject" | "dismiss" }) => {
      setBusyCandidateId(input.id);
      if (input.action === "test") return reflexApi.testCandidate(input.id);
      if (input.action === "approve") return reflexApi.approveCandidate(input.id);
      if (input.action === "reject") return reflexApi.rejectCandidate(input.id);
      return reflexApi.dismissCandidate(input.id);
    },
    onSuccess: async () => {
      await invalidateReflex();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : localize(locale, "候选项操作失败", "Candidate action failed")),
    onSettled: () => setBusyCandidateId(null),
  });

  const revokePreferenceMutation = useMutation({
    mutationFn: async (id: string) => {
      setBusyPreferenceId(id);
      return reflexApi.revokePreference(id);
    },
    onSuccess: async () => {
      toast.success(localize(locale, "偏好已撤销", "Preference revoked"));
      await invalidateReflex();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : localize(locale, "撤销失败", "Failed to revoke preference")),
    onSettled: () => setBusyPreferenceId(null),
  });

  const onboarding = onboardingQuery.data;
  const activeQuestion = onboarding?.activeQuestion ?? null;
  const candidates = candidatesQuery.data?.items ?? [];
  const preferences = preferencesQuery.data?.items ?? [];
  const readyCount = useMemo(
    () => candidates.filter((candidate) => candidate.status === "ready_for_review").length,
    [candidates],
  );

  return (
    <div className="space-y-5 pb-4">
      <section className="agent-header">
        <div>
          <p className="agent-eyebrow">Friday Reflex</p>
          <h2 className="agent-card-title">
            {localize(locale, "把学习候选、偏好和引导闭环", "Close the loop on learning candidates, preferences, and onboarding")}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "这里展示 Friday 从运行、渠道和引导中学到的内容：先生成候选，再测试和审核，最后才写入记忆、偏好、技能或工作流。",
              "This surface shows what Friday learns from runs, channels, and onboarding: candidates are proposed, tested, reviewed, then applied to memory, preferences, skills, or workflows.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton tone="secondary" onClick={() => void invalidateReflex()}>
            <RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" />
            {localize(locale, "刷新", "Refresh")}
          </ActionButton>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        <ShellCard title={localize(locale, "候选审核", "Candidate Review")}>
          <p className="text-2xl font-semibold text-[color:var(--color-text-primary)]">{String(candidates.length)}</p>
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {readyCount > 0
              ? localize(locale, `${String(readyCount)} 个待审核`, `${String(readyCount)} ready for review`)
              : localize(locale, "当前筛选下没有阻塞项", "No blockers in this filter")}
          </p>
        </ShellCard>
        <ShellCard title={localize(locale, "引导进度", "Onboarding Progress")}>
          <p className="text-2xl font-semibold text-[color:var(--color-text-primary)]">
            {onboarding ? `${String(onboarding.progress.completed)}/${String(onboarding.progress.total)}` : "-"}
          </p>
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {onboarding?.session?.status ?? localize(locale, "未开始", "not_started")}
          </p>
        </ShellCard>
        <ShellCard title={localize(locale, "显式偏好", "Explicit Preferences")}>
          <p className="text-2xl font-semibold text-[color:var(--color-text-primary)]">{String(preferences.length)}</p>
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "会进入 prompt 和 UIX 偏好面", "Available to prompts and UIX surfaces")}
          </p>
        </ShellCard>
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          ["review", localize(locale, "审核队列", "Review Queue")],
          ["onboarding", localize(locale, "引导问题", "Onboarding")],
          ["preferences", localize(locale, "偏好快照", "Preferences")],
        ] as Array<[ReflexTab, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
              tab === value
                ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-bg-base)]"
                : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "review" ? (
        <ShellCard
          eyebrow={localize(locale, "候选状态机", "Candidate State Machine")}
          title={localize(locale, "测试、批准或拒绝 Friday 学到的新机制", "Test, approve, or reject what Friday learned")}
          aside={(
            <select
              className="agent-select !min-h-[38px] !w-auto !rounded-xl !px-3 !py-1 text-sm"
              value={status}
              onChange={(event) => setStatus(event.target.value as ReflexCandidateStatus)}
              aria-label={localize(locale, "筛选候选状态", "Filter candidate status")}
            >
              {CANDIDATE_STATUSES.map((item) => (
                <option key={item.value} value={item.value}>
                  {localize(locale, item.labelZh, item.labelEn)}
                </option>
              ))}
            </select>
          )}
        >
          {candidatesQuery.isLoading ? (
            <SkeletonList rows={4} />
          ) : candidates.length === 0 ? (
            <EmptyState
              title={localize(locale, "没有这个状态的候选项", "No candidates in this state")}
              description={localize(locale, "运行完成、引导回答或渠道学习后，新的候选会进入这里。", "After runs, onboarding answers, or channel learning, new candidates will appear here.")}
            />
          ) : (
            <div className="space-y-3">
              {candidates.map((candidate) => (
                <ReflexCandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  isPending={candidateMutation.isPending && busyCandidateId === candidate.id}
                  onTest={(id) => candidateMutation.mutate({ id, action: "test" })}
                  onApprove={(id) => candidateMutation.mutate({ id, action: "approve" })}
                  onReject={(id) => candidateMutation.mutate({ id, action: "reject" })}
                  onDismiss={(id) => candidateMutation.mutate({ id, action: "dismiss" })}
                />
              ))}
            </div>
          )}
        </ShellCard>
      ) : null}

      {tab === "onboarding" ? (
        <ShellCard
          eyebrow={localize(locale, "Day 0 Reflex", "Day 0 Reflex")}
          title={localize(locale, "用几个问题建立初始偏好", "Seed initial preferences with a few questions")}
          aside={(
            <ActionButton
              tone="secondary"
              disabled={startOnboardingMutation.isPending}
              onClick={() => startOnboardingMutation.mutate()}
            >
              <ClipboardCheck className="mr-2 h-4 w-4" aria-hidden="true" />
              {localize(locale, "开始/继续", "Start or continue")}
            </ActionButton>
          )}
        >
          {onboardingQuery.isLoading ? (
            <SkeletonList rows={3} />
          ) : activeQuestion ? (
            <div className="space-y-4">
              <div>
                <StatusPill tone="warning">{activeQuestion.id}</StatusPill>
                <h3 className="mt-3 text-lg font-semibold text-[color:var(--color-text-primary)]">{activeQuestion.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{activeQuestion.prompt}</p>
                <p className="mt-1 text-xs text-[color:var(--color-text-faint)]">{activeQuestion.scenario}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {activeQuestion.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={answerMutation.isPending}
                    onClick={() => answerMutation.mutate({ questionId: activeQuestion.id, value: option.value })}
                    className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 text-left transition hover:border-[color:var(--color-accent)] hover:bg-[color:var(--color-accent-muted)] disabled:opacity-50"
                  >
                    <span className="text-sm font-semibold text-[color:var(--color-text-primary)]">{option.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[color:var(--color-text-secondary)]">{option.description}</span>
                  </button>
                ))}
              </div>
              <ActionButton
                tone="secondary"
                disabled={skipMutation.isPending}
                onClick={() => skipMutation.mutate(activeQuestion.id)}
              >
                <SkipForward className="mr-2 h-4 w-4" aria-hidden="true" />
                {localize(locale, "跳过这个问题", "Skip this question")}
              </ActionButton>
            </div>
          ) : (
            <EmptyState
              title={localize(locale, "当前没有待回答问题", "No active question")}
              description={localize(locale, "如果还没开始，可以点击开始；普通偏好会显示在快照里，需要确认的设置会先进入审核候选。", "Start onboarding if needed; ordinary preferences appear in the snapshot, while settings that need confirmation appear as review candidates first.")}
            />
          )}
        </ShellCard>
      ) : null}

      {tab === "preferences" ? (
        <ShellCard
          eyebrow={localize(locale, "Canonical Preferences", "Canonical Preferences")}
          title={localize(locale, "跨渠道、prompt 和 UI 使用的偏好", "Preferences shared by channels, prompts, and UI")}
        >
          {preferencesQuery.isLoading ? (
            <SkeletonList rows={4} />
          ) : preferences.length === 0 ? (
            <EmptyState
              title={localize(locale, "还没有 Reflex 偏好", "No Reflex preferences yet")}
              description={localize(locale, "完成引导或让 Friday 记录普通偏好后，这里会显示可复用设置；需要确认的设置会先进入审核候选。", "Complete onboarding or ask Friday to record ordinary preferences to populate reusable settings; settings that need confirmation appear as review candidates first.")}
            />
          ) : (
            <div className="divide-y divide-[color:var(--color-border-soft)]">
              {preferences.map((preference) => (
                <div key={preference.id} className="grid gap-3 py-3 md:grid-cols-[180px_1fr_150px_112px] md:items-center">
                  <div>
                    <StatusPill>{preference.category}</StatusPill>
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">{preference.source}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{preference.key}</p>
                    <p className="mt-1 break-words text-sm text-[color:var(--color-text-secondary)]">
                      {typeof preference.value === "string" ? preference.value : JSON.stringify(preference.value)}
                    </p>
                  </div>
                  <p className="text-xs text-[color:var(--color-text-faint)] md:text-right">
                    {formatTime(preference.updatedAt)}
                  </p>
                  <div className="flex md:justify-end">
                    <ActionButton
                      tone="secondary"
                      className="!min-h-[34px] !px-3 !text-xs"
                      disabled={revokePreferenceMutation.isPending && busyPreferenceId === preference.id}
                      onClick={() => revokePreferenceMutation.mutate(preference.id)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {localize(locale, "撤销", "Revoke")}
                    </ActionButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ShellCard>
      ) : null}
    </div>
  );
}
