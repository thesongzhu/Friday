import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Loader2, PlayCircle, Save, Sparkles, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { useAuth } from "@/hooks/use-auth";
import { skillsApi } from "@/lib/api/skills";
import type {
  ApproveResponse,
  GeneratedSkillDraft,
  GeneratedSkillValidationIssue,
  SkillGenerationEvidence,
  SkillGenerationSession,
  SkillGenerationTurn,
  SkillGeneratorTestSummary,
} from "@/lib/api/types";
import {
  clearLastSkillGeneratorSessionId,
  readLastSkillGeneratorSessionId,
  writeLastSkillGeneratorSessionId,
} from "@/lib/skills/generator-session";
import { buildSkillGeneratorHref, buildSkillHref } from "@/lib/skills/view-models";

function formatTimestamp(value?: string): string {
  if (!value) return "Not yet";
  return new Date(value).toLocaleString();
}

function toneForIssueSeverity(severity: "error" | "warning"): "danger" | "warning" {
  return severity === "error" ? "danger" : "warning";
}

function toneForSessionStatus(status?: SkillGenerationSession["status"]): "neutral" | "success" | "warning" | "danger" {
  if (status === "approved" || status === "saved") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "ready_for_review") return "warning";
  return "neutral";
}

function toneForTestResult(test?: SkillGeneratorTestSummary | null): "neutral" | "success" | "warning" | "danger" {
  if (!test) return "neutral";
  if (test.ok && test.executable) return "success";
  if (test.ok) return "warning";
  return "danger";
}

function summarizeDraftIssues(draft?: GeneratedSkillDraft): GeneratedSkillValidationIssue[] {
  return draft?.validation.issues ?? [];
}

export function SkillGeneratorPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [goalInput, setGoalInput] = useState(searchParams.get("goal") ?? "");
  const [messageInput, setMessageInput] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [approvalReceipt, setApprovalReceipt] = useState<ApproveResponse | null>(null);
  const requestedSessionId = searchParams.get("sessionId");
  const requestedGoal = searchParams.get("goal");
  const requestSource = searchParams.get("from") ?? "skills";

  useEffect(() => {
    if (requestedSessionId || requestedGoal) {
      return;
    }
    const lastSessionId = readLastSkillGeneratorSessionId();
    if (!lastSessionId) return;
    const next = new URLSearchParams(searchParams);
    next.set("sessionId", lastSessionId);
    setSearchParams(next, { replace: true });
  }, [requestedGoal, requestedSessionId, searchParams, setSearchParams]);

  useEffect(() => {
    const goalFromQuery = searchParams.get("goal");
    if (goalFromQuery && goalInput.trim().length === 0) {
      setGoalInput(goalFromQuery);
    }
  }, [goalInput, searchParams]);

  const sessionQuery = useQuery({
    queryKey: ["skills", "generator", "session", requestedSessionId],
    queryFn: () => skillsApi.getGeneratorSession(requestedSessionId!),
    enabled: Boolean(requestedSessionId),
    refetchInterval: requestedSessionId ? 10_000 : false,
  });

  const evidenceQuery = useQuery({
    queryKey: ["skills", "generator", "evidence", requestedSessionId],
    queryFn: () => skillsApi.getGenerationEvidence(requestedSessionId!),
    enabled: Boolean(requestedSessionId && !approvalReceipt),
    retry: false,
  });

  const startMutation = useMutation({
    mutationFn: () =>
      skillsApi.startGeneratorSession({
        goal: goalInput.trim(),
        userId: user?.id ?? "local-operator",
        channel: requestSource,
      }),
    onSuccess: (result) => {
      writeLastSkillGeneratorSessionId(result.session.sessionId);
      setApprovalReceipt(null);
      const next = new URLSearchParams(searchParams);
      next.set("sessionId", result.session.sessionId);
      if (goalInput.trim()) next.set("goal", goalInput.trim());
      next.set("from", requestSource);
      setSearchParams(next, { replace: false });
      toast.success("Skill generator session started.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not start the skill generator session");
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => skillsApi.submitGeneratorMessage(requestedSessionId!, { message: messageInput.trim() }),
    onSuccess: async (result) => {
      writeLastSkillGeneratorSessionId(result.session.sessionId);
      setMessageInput("");
      await queryClient.invalidateQueries({ queryKey: ["skills", "generator", "session", result.session.sessionId] });
      toast.success("Clarification captured.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not send the clarification");
    },
  });

  const generateMutation = useMutation({
    mutationFn: () => skillsApi.generateDraft(requestedSessionId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skills", "generator", "session", requestedSessionId] });
      toast.success("Draft skill generated.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not generate a draft");
    },
  });

  const testMutation = useMutation({
    mutationFn: () => skillsApi.testSession(requestedSessionId!),
    onSuccess: () => {
      toast.success("Skill test completed.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not run the skill test");
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => skillsApi.approveSession(requestedSessionId!),
    onSuccess: async (result) => {
      setApprovalReceipt(result);
      writeLastSkillGeneratorSessionId(result.sessionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        queryClient.invalidateQueries({ queryKey: ["skills", "generator", "session", result.sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["skills", "generator", "evidence", result.sessionId] }),
      ]);
      toast.success("Skill saved and promoted.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not approve and save the skill");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => skillsApi.cancelSession(requestedSessionId!),
    onSuccess: async () => {
      if (requestedSessionId && readLastSkillGeneratorSessionId() === requestedSessionId) {
        clearLastSkillGeneratorSessionId();
      }
      await queryClient.invalidateQueries({ queryKey: ["skills", "generator", "session", requestedSessionId] });
      toast.success("Generator session cancelled.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not cancel the generator session");
    },
  });

  const session = startMutation.data?.session
    ?? submitMutation.data?.session
    ?? sessionQuery.data?.session
    ?? null;
  const turns = sessionQuery.data?.turns ?? [];
  const draft = generateMutation.data?.draft
    ?? submitMutation.data?.draft
    ?? startMutation.data?.draft
    ?? sessionQuery.data?.draft
    ?? null;
  const validationIssues = summarizeDraftIssues(draft ?? undefined);
  const testSummary = testMutation.data ?? approvalReceipt?.evidence.executableTestSummary ?? evidenceQuery.data?.executableTestSummary ?? null;
  const evidence = approvalReceipt?.evidence ?? evidenceQuery.data ?? null;
  const savedSkillId = approvalReceipt?.skillId ?? evidence?.savedSkillIdentity?.skillId ?? null;
  const savedSkillDir = approvalReceipt?.skillDir ?? evidence?.savedSkillIdentity?.skillDir ?? null;

  useEffect(() => {
    if (!draft?.files?.length) {
      setSelectedFilePath(null);
      return;
    }
    if (!selectedFilePath || !draft.files.some((file) => file.path === selectedFilePath)) {
      setSelectedFilePath(draft.files[0]?.path ?? null);
    }
  }, [draft, selectedFilePath]);

  const selectedFile = draft?.files.find((file) => file.path === selectedFilePath) ?? draft?.files[0] ?? null;
  const questions = useMemo(
    () =>
      startMutation.data?.questions
      ?? submitMutation.data?.questions
      ?? session?.openQuestions
      ?? [],
    [session?.openQuestions, startMutation.data?.questions, submitMutation.data?.questions],
  );

  const beginAnotherSession = () => {
    clearLastSkillGeneratorSessionId();
    setApprovalReceipt(null);
    setMessageInput("");
    setGoalInput("");
    setSearchParams(new URLSearchParams(), { replace: false });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[0.84fr_1.06fr_0.9fr]">
      <div className="space-y-4">
        <ShellCard
          eyebrow="Generator Timeline"
          title={session ? session.goal : "Start a new skill generator session"}
          aside={session ? <StatusPill tone={toneForSessionStatus(session.status)}>{session.status}</StatusPill> : undefined}
        >
          <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
            <label className="grid gap-2">
              <span className="font-medium text-[color:var(--color-text-primary)]">Goal</span>
              <textarea
                value={goalInput}
                onChange={(event) => setGoalInput(event.target.value)}
                rows={5}
                className="agent-input min-h-[148px]"
                placeholder="Describe the skill you want Friday to package."
                data-testid="skill-generator-goal-input"
              />
            </label>
            <ActionButton
              disabled={startMutation.isPending || goalInput.trim().length === 0}
              onClick={() => startMutation.mutate()}
              data-testid="skill-generator-start"
            >
              {startMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Start session
            </ActionButton>
            <div className="grid gap-3 sm:grid-cols-2">
              <GeneratorMetric label="Source" value={requestSource} />
              <GeneratorMetric label="Updated" value={formatTimestamp(session?.updatedAt)} />
            </div>
            <div className="agent-subcard p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Open questions</p>
              <div className="mt-3 space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                {questions.length > 0 ? questions.map((question) => (
                  <div key={question} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
                    {question}
                  </div>
                )) : (
                  <p>No open clarification questions right now.</p>
                )}
              </div>
            </div>
            <label className="grid gap-2">
              <span className="font-medium text-[color:var(--color-text-primary)]">Continue the conversation</span>
              <textarea
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
                rows={4}
                className="agent-input min-h-[120px]"
                placeholder="Answer the open questions or add constraints before regenerating."
                data-testid="skill-generator-message-input"
              />
            </label>
            <ActionButton
              tone="secondary"
              disabled={submitMutation.isPending || !requestedSessionId || messageInput.trim().length === 0}
              onClick={() => submitMutation.mutate()}
              data-testid="skill-generator-send"
            >
              {submitMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save clarification
            </ActionButton>
          </div>
        </ShellCard>

        <ShellCard eyebrow="Session Turns" title="Conversation history">
          <div className="space-y-3 text-sm text-[color:var(--color-text-secondary)]">
            {turns.length === 0 ? (
              <p>No turns yet. Start the session to begin the clarification loop.</p>
            ) : turns.map((turn) => (
              <div key={turn.turnId} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4" data-testid={`skill-generator-turn-${turn.turnId}`}>
                <div className="flex items-center justify-between gap-3">
                  <StatusPill>{turn.role}</StatusPill>
                  <span className="text-xs text-[color:var(--color-text-faint)]">{formatTimestamp(turn.createdAt)}</span>
                </div>
                <p className="mt-3 whitespace-pre-wrap leading-6 text-[color:var(--color-text-secondary)]">{turn.content}</p>
              </div>
            ))}
          </div>
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow="Draft Review"
          title={draft?.manifest.name ?? "No generated draft yet"}
          aside={draft ? <StatusPill tone={draft.validation.ok ? "success" : "warning"}>{draft.runtimeKind}</StatusPill> : undefined}
        >
          {draft ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <div className="grid gap-3 sm:grid-cols-3">
                <GeneratorMetric label="Skill ID" value={draft.manifest.id} />
                <GeneratorMetric label="Version" value={draft.manifest.version} />
                <GeneratorMetric label="Runtime" value={draft.runtimeKind} />
              </div>
              <div className="agent-subcard p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Manifest summary</p>
                <p className="mt-2 text-base font-semibold text-[color:var(--color-text-primary)]">{draft.manifest.name}</p>
                <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{draft.manifest.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {draft.manifest.tags.map((tag) => (
                    <StatusPill key={tag}>{tag}</StatusPill>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-[0.46fr_0.54fr]">
                <div className="space-y-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Validation issues</p>
                  {validationIssues.length === 0 ? (
                    <div className="rounded-2xl border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] p-4 text-sm text-[color:var(--color-text-primary)]">
                      Validation passed. Friday did not find manifest or runtime blockers in the current draft.
                    </div>
                  ) : validationIssues.map((issue) => (
                    <div key={`${issue.code}:${issue.message}`} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-[color:var(--color-text-primary)]">{issue.code}</p>
                        <StatusPill tone={toneForIssueSeverity(issue.severity)}>{issue.severity}</StatusPill>
                      </div>
                      <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{issue.message}</p>
                      {issue.path ? <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">{issue.path}</p> : null}
                    </div>
                  ))}
                </div>
                <div className="space-y-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Draft files</p>
                  <div className="grid gap-3 lg:grid-cols-[0.36fr_0.64fr]">
                    <div className="space-y-2">
                      {draft.files.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => setSelectedFilePath(file.path)}
                          className="agent-selection-card w-full text-left"
                          data-active={selectedFilePath === file.path}
                        >
                          <p className="font-medium text-[color:var(--color-text-primary)]">{file.path.split("/").pop()}</p>
                          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">{file.language}</p>
                        </button>
                      ))}
                    </div>
                    <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-[color:var(--color-text-primary)]">{selectedFile?.path ?? "No file selected"}</p>
                        <StatusPill>{selectedFile?.language ?? "n/a"}</StatusPill>
                      </div>
                      <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-[color:var(--color-text-secondary)]">
                        {selectedFile?.content ?? "Select a generated file to inspect its contents."}
                      </pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-tertiary)]">Generate a draft to inspect the manifest, validation issues, and generated files.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Evidence"
          title="Test result and promotion evidence"
          aside={<StatusPill tone={toneForTestResult(testSummary)}>{testSummary ? "tested" : "pending"}</StatusPill>}
        >
          <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
            {testSummary ? (
              <div className="grid gap-3 sm:grid-cols-4">
                <GeneratorMetric label="Executable" value={testSummary.executable ? "yes" : "no"} />
                <GeneratorMetric label="Result" value={testSummary.ok ? "passed" : "issues"} />
                <GeneratorMetric label="Duration" value={`${testSummary.durationMs} ms`} />
                <GeneratorMetric label="Issues" value={String(testSummary.issues.length)} />
              </div>
            ) : (
              <p>No test has been run yet for this session.</p>
            )}

            {approvalReceipt ? (
              <div className="rounded-[24px] border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] p-4" data-testid="skill-generator-approve-receipt">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-base font-semibold text-[color:var(--color-text-primary)]">Approve success receipt</p>
                  <StatusPill tone="success">{approvalReceipt.promotionStage}</StatusPill>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <GeneratorMetric label="Skill ID" value={approvalReceipt.skillId} />
                  <GeneratorMetric label="Registry refreshed" value={approvalReceipt.registryRefreshed ? "yes" : "no"} />
                  <GeneratorMetric label="Skill dir" value={approvalReceipt.skillDir} />
                  <GeneratorMetric label="Saved files" value={String(approvalReceipt.savedFiles.length)} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {approvalReceipt.promotedManifestTags.map((tag) => (
                    <StatusPill key={tag}>{tag}</StatusPill>
                  ))}
                </div>
              </div>
            ) : null}

            {evidence ? (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="agent-subcard p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Validation summary</p>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    Ready: {evidence.approvalReadiness.ready ? "yes" : "no"} · {evidence.approvalReadiness.reason}
                  </p>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    Repair attempts: {evidence.repairSummary.attempts} · Issue count: {evidence.validationSummary.issueCount}
                  </p>
                </div>
                <div className="agent-subcard p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Saved skill identity</p>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{savedSkillId ?? "Not saved yet"}</p>
                  <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">{savedSkillDir ?? "Skill directory will appear after approve."}</p>
                </div>
              </div>
            ) : (
              <p>No promotion evidence yet. Approve the session to see the final receipt and saved skill identity.</p>
            )}
          </div>
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard eyebrow="Actions" title="Generate, test, approve, or cancel">
          <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
            <div className="grid gap-3 sm:grid-cols-2">
              <ActionButton
                disabled={!requestedSessionId || generateMutation.isPending}
                onClick={() => generateMutation.mutate()}
                data-testid="skill-generator-generate"
              >
                {generateMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                Generate draft
              </ActionButton>
              <ActionButton
                tone="secondary"
                disabled={!requestedSessionId || testMutation.isPending}
                onClick={() => testMutation.mutate()}
                data-testid="skill-generator-test"
              >
                {testMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
                Run test
              </ActionButton>
              <ActionButton
                disabled={!requestedSessionId || !draft || approveMutation.isPending}
                onClick={() => approveMutation.mutate()}
                data-testid="skill-generator-approve"
              >
                {approveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Approve
              </ActionButton>
              <ActionButton
                tone="danger"
                disabled={!requestedSessionId || cancelMutation.isPending}
                onClick={() => cancelMutation.mutate()}
                data-testid="skill-generator-cancel"
              >
                {cancelMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                Cancel
              </ActionButton>
            </div>

            <div className="agent-subcard p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Approve success CTAs</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <Link
                  className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                  to={savedSkillId ? buildSkillHref(savedSkillId) : "/skills"}
                >
                  <BadgeCheck className="mr-2 h-4 w-4" />
                  Open skill detail
                </Link>
                <button
                  type="button"
                  className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                  onClick={beginAnotherSession}
                >
                  Start another generator session
                </button>
                <Link
                  className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                  to="/skills"
                >
                  Return to skills
                </Link>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <GeneratorMetric label="Session" value={requestedSessionId ?? "none"} />
              <GeneratorMetric label="Last updated" value={formatTimestamp(session?.updatedAt)} />
            </div>

            {savedSkillId ? (
              <ActionButton tone="secondary" onClick={() => navigate(buildSkillHref(savedSkillId))}>
                Open saved skill
              </ActionButton>
            ) : (
              <Link
                className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                to={buildSkillGeneratorHref({ sessionId: requestedSessionId ?? undefined, goal: goalInput || undefined, from: requestSource === "assistant" ? "assistant" : "skills" })}
              >
                Copy deep link
              </Link>
            )}
          </div>
        </ShellCard>
      </div>
    </div>
  );
}

function GeneratorMetric(props: { label: string; value: string }) {
  return (
    <div className="agent-metric-card">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{props.label}</p>
      <p className="mt-3 break-words text-sm text-[color:var(--color-text-primary)]">{props.value}</p>
    </div>
  );
}

export const __skillGeneratorTestExports = {
  toneForSessionStatus,
  toneForTestResult,
  summarizeDraftIssues,
};
