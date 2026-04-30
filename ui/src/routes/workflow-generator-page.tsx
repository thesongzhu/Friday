import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, FileSearch, MessageSquareText, Sparkles } from "lucide-react";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { workflowGeneratorApi } from "@/lib/api/workflow-generator";
import type {
  FridayGeneratedWorkflowDraft,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGeneratorEvidenceResponse,
} from "@/lib/api/types";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

function statusTone(status?: FridayWorkflowGenerationSession["status"]): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "approved":
    case "saved":
    case "ready_for_review":
      return "success";
    case "needs_clarification":
    case "generating":
    case "draft_ready_needs_repair":
    case "retryable_provider_failure":
      return "warning";
    case "terminal_failed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

function draftTitle(draft?: FridayGeneratedWorkflowDraft): string {
  return draft?.spec?.name ?? draft?.compiledGraph?.workflowId ?? "Draft workflow";
}

export function WorkflowGeneratorPage() {
  const { locale } = useAppLocale();
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [message, setMessage] = useState("");
  const [session, setSession] = useState<FridayWorkflowGenerationSession | null>(null);
  const [turns, setTurns] = useState<FridayWorkflowGenerationTurn[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [draft, setDraft] = useState<FridayGeneratedWorkflowDraft | undefined>();
  const [evidence, setEvidence] = useState<FridayWorkflowGeneratorEvidenceResponse["evidence"] | undefined>();

  const sessionId = session?.sessionId;
  const canGenerate = Boolean(sessionId) && session?.status !== "saved" && session?.status !== "approved";
  const canApprove = Boolean(sessionId && draft);

  const issueSummary = useMemo(() => {
    const issues = draft?.validation?.issues ?? [];
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const warnings = issues.filter((issue) => issue.severity === "warning").length;
    return { errors, warnings };
  }, [draft]);

  const startMutation = useMutation({
    mutationFn: async () =>
      workflowGeneratorApi.startSession({
        goal,
        userId: "local",
        channel: "ui",
      }),
    onSuccess: (result) => {
      setSession(result.session);
      setQuestions(result.questions ?? []);
      setDraft(result.draft);
      setTurns([]);
      setEvidence(undefined);
      toast.success(localize(locale, "生成会话已开始", "Generator session started"));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "无法启动生成器", "Unable to start generator"));
    },
  });

  const refreshSession = async (id: string) => {
    const result = await workflowGeneratorApi.getSession(id);
    setSession(result.session);
    setTurns(result.turns);
    setDraft(result.draft);
    return result;
  };

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No generator session");
      return workflowGeneratorApi.submitMessage(sessionId, { message });
    },
    onSuccess: async (result) => {
      setSession(result.session);
      setQuestions(result.questions ?? []);
      setDraft(result.draft);
      setMessage("");
      await refreshSession(result.session.sessionId);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "无法发送回答", "Unable to submit answer"));
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No generator session");
      return workflowGeneratorApi.generateDraft(sessionId);
    },
    onSuccess: async (result) => {
      setDraft(result.draft);
      if (sessionId) await refreshSession(sessionId);
      toast.success(localize(locale, "草案已生成", "Draft generated"));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "无法生成草案", "Unable to generate draft"));
    },
  });

  const evidenceMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No generator session");
      return workflowGeneratorApi.getEvidence(sessionId);
    },
    onSuccess: (result) => setEvidence(result.evidence),
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "无法读取证据", "Unable to load evidence"));
    },
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No generator session");
      return workflowGeneratorApi.approveSession(sessionId);
    },
    onSuccess: (result) => {
      toast.success(localize(locale, "工作流已保存", "Workflow saved"));
      navigate(`/workflows/builder?workflowId=${encodeURIComponent(result.workflowId)}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "无法保存工作流", "Unable to save workflow"));
    },
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="agent-eyebrow">{localize(locale, "工作流生成器", "Workflow generator")}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            {localize(locale, "从目标生成可审核的工作流草案", "Generate reviewable workflow drafts from goals")}
          </h1>
        </div>
        <Link
          className="inline-flex min-h-[40px] items-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
          to="/workflows"
        >
          {localize(locale, "返回工作流", "Back to workflows")}
        </Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <ShellCard
            eyebrow={localize(locale, "目标", "Goal")}
            title={localize(locale, "告诉 Friday 要自动化什么", "Tell Friday what to automate")}
            aside={<StatusPill tone={statusTone(session?.status)}>{session?.status ?? "idle"}</StatusPill>}
          >
            <div className="space-y-3">
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                className="min-h-[132px] w-full resize-y rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                placeholder={localize(locale, "例如：每天早上汇总渠道消息并生成待办。", "Example: summarize channel messages every morning and create tasks.")}
              />
              <div className="flex flex-wrap gap-2">
                <ActionButton disabled={goal.trim().length === 0 || startMutation.isPending} onClick={() => startMutation.mutate()}>
                  <Sparkles className="mr-2 size-4" />
                  {localize(locale, "开始生成", "Start")}
                </ActionButton>
                <ActionButton tone="secondary" disabled={!canGenerate || generateMutation.isPending} onClick={() => generateMutation.mutate()}>
                  <FileSearch className="mr-2 size-4" />
                  {localize(locale, "生成草案", "Generate draft")}
                </ActionButton>
                <ActionButton tone="secondary" disabled={!canApprove || approveMutation.isPending} onClick={() => approveMutation.mutate()}>
                  <Check className="mr-2 size-4" />
                  {localize(locale, "批准保存", "Approve")}
                </ActionButton>
              </div>
            </div>
          </ShellCard>

          <ShellCard eyebrow={localize(locale, "澄清", "Clarification")} title={localize(locale, "回答缺口后再生成", "Answer gaps before generation")}>
            <div className="space-y-4">
              {questions.length > 0 ? (
                <ul className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                  {questions.map((question) => (
                    <li key={question} className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-3">{question}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[color:var(--color-text-secondary)]">
                  {localize(locale, "当前没有开放问题。", "No open questions right now.")}
                </p>
              )}
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                className="min-h-[96px] w-full resize-y rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                placeholder={localize(locale, "补充触发条件、数据来源、失败处理或审批要求。", "Add triggers, data sources, failure handling, or approval requirements.")}
              />
              <ActionButton tone="secondary" disabled={!sessionId || message.trim().length === 0 || submitMutation.isPending} onClick={() => submitMutation.mutate()}>
                <MessageSquareText className="mr-2 size-4" />
                {localize(locale, "发送回答", "Send answer")}
              </ActionButton>
            </div>
          </ShellCard>

          <ShellCard eyebrow={localize(locale, "会话", "Session")} title={localize(locale, "生成器对话记录", "Generator conversation")}>
            {turns.length > 0 ? (
              <div className="space-y-3">
                {turns.map((turn) => (
                  <div key={turn.turnId} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-tertiary)]">{turn.role}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-[color:var(--color-text-primary)]">{turn.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "开始会话后，澄清和生成记录会显示在这里。", "Clarification and generation turns appear here after the session starts.")}
              </p>
            )}
          </ShellCard>
        </div>

        <div className="space-y-5">
          <ShellCard
            eyebrow={localize(locale, "草案", "Draft")}
            title={draftTitle(draft)}
            aside={<StatusPill tone={draft?.validation?.ok ? "success" : draft ? "warning" : "neutral"}>{draft?.validation?.ok ? "valid" : draft ? "check" : "empty"}</StatusPill>}
          >
            {draft ? (
              <div className="space-y-3 text-sm text-[color:var(--color-text-secondary)]">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] p-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-tertiary)]">nodes</p>
                    <p className="mt-1 text-xl font-semibold text-[color:var(--color-text-primary)]">{draft.compiledGraph.graph.nodes.length}</p>
                  </div>
                  <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] p-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-tertiary)]">issues</p>
                    <p className="mt-1 text-xl font-semibold text-[color:var(--color-text-primary)]">{issueSummary.errors}/{issueSummary.warnings}</p>
                  </div>
                </div>
                <p>{draft.spec.description ?? localize(locale, "没有描述。", "No description.")}</p>
                {draft.validation.issues.length > 0 ? (
                  <ul className="space-y-2">
                    {draft.validation.issues.slice(0, 5).map((issue) => (
                      <li key={`${issue.code}-${issue.path ?? issue.message}`} className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-3 py-2">
                        <span className="font-medium text-[color:var(--color-text-primary)]">{issue.severity}</span> {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "生成草案后会显示结构、验证和保存入口。", "Draft structure, validation, and save actions appear after generation.")}
              </p>
            )}
          </ShellCard>

          <ShellCard
            eyebrow={localize(locale, "证据", "Evidence")}
            title={localize(locale, "生成与批准证据", "Generation and approval evidence")}
            aside={
              <ActionButton className="min-h-[34px] px-3 py-1 text-xs" tone="secondary" disabled={!sessionId || evidenceMutation.isPending} onClick={() => evidenceMutation.mutate()}>
                {localize(locale, "刷新", "Refresh")}
              </ActionButton>
            }
          >
            {evidence ? (
              <pre className="max-h-[320px] overflow-auto rounded-2xl bg-[color:var(--color-bg-subtle)] p-3 text-xs text-[color:var(--color-text-secondary)]">
                {JSON.stringify(evidence, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "保存前后可以拉取生成证据，确认草案来源和校验结果。", "Load evidence before or after saving to inspect generation source and validation results.")}
              </p>
            )}
          </ShellCard>
        </div>
      </div>
    </div>
  );
}
