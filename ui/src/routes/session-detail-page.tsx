import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, GitBranch, History, MessageSquare, ShieldCheck, Split, TerminalSquare } from "lucide-react";
import { MarkdownContent } from "@/components/chat/chat-message";
import { SkeletonList } from "@/components/core/primitives";
import { sessionsApi } from "@/lib/api/sessions";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import type { FridaySessionMessageRecord, FridaySessionRecord } from "@/lib/api/types";

type TruthState = "wired_registry" | "NO-GO";

type LifecycleState = {
  key: string;
  label: string;
  detail: string;
  tone: "neutral" | "ok" | "warn" | "danger";
};

const LIFECYCLE_STATES: LifecycleState[] = [
  { key: "pending", label: "Pending", detail: "Composed locally; not provider-backed yet.", tone: "neutral" },
  { key: "sentToHub", label: "Sent", detail: "Submitted to Hub; awaiting acceptance.", tone: "neutral" },
  { key: "accepted", label: "Accepted", detail: "Hub accepted the turn; routing proof still pending.", tone: "ok" },
  { key: "routed", label: "Routed", detail: "Routed to provider adapter; provider has not responded.", tone: "ok" },
  { key: "waitingProvider", label: "Waiting", detail: "Awaiting provider stream or result.", tone: "warn" },
  { key: "providerCompleted", label: "Provider done", detail: "Provider returned; local receipt still required.", tone: "ok" },
  { key: "blocked", label: "Blocked", detail: "Gate or approval refused; cannot proceed on this path.", tone: "danger" },
  { key: "failed", label: "Failed", detail: "Retryable failure; never silently marked done.", tone: "danger" },
  { key: "failedTerminal", label: "Failed terminal", detail: "Terminal failure surfaced with no quiet success state.", tone: "danger" },
  { key: "backpressure", label: "Backpressure", detail: "Slow consumer; upstream events remain ordered.", tone: "warn" },
  { key: "deltaSnapshot", label: "Delta / snapshot", detail: "Missed deltas require snapshot resync after a gap.", tone: "warn" },
  { key: "cancelled", label: "Cancelled", detail: "Turn cancelled by operator or Hub.", tone: "warn" },
  { key: "reconnecting", label: "Reconnecting", detail: "Transport dropped; state remains stale until resync.", tone: "warn" },
];

const SESSION_CONTROLS = [
  { label: "Send", capability: "provider_adapter_parity_codex_claude", truth: "NO-GO" },
  { label: "Stop", capability: "session_control_native_set", truth: "NO-GO" },
  { label: "Steer", capability: "session_control_native_set", truth: "NO-GO" },
  { label: "Resume", capability: "session_control_native_set", truth: "NO-GO" },
  { label: "Fork", capability: "session_control_native_set", truth: "NO-GO" },
  { label: "Archive", capability: "session_control_native_set", truth: "NO-GO" },
  { label: "Tools", capability: "provider_adapter_parity_codex_claude", truth: "NO-GO" },
  { label: "Approvals", capability: "security_approval_bound_principal_gate_cat10_netnew", truth: "wired_registry" },
  { label: "Files", capability: "provider_adapter_parity_codex_claude", truth: "NO-GO" },
  { label: "Diffs", capability: "provider_adapter_parity_codex_claude", truth: "NO-GO" },
  { label: "Attach", capability: "provider_adapter_parity_codex_claude", truth: "NO-GO" },
  { label: "History", capability: "session_control_native_set", truth: "NO-GO" },
] satisfies Array<{ label: string; capability: string; truth: TruthState }>;

function formatDate(iso?: string): string {
  if (!iso) return "unknown";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function messageText(message: FridaySessionMessageRecord): string {
  if (message.contentText) return message.contentText;
  if (typeof message.content === "string") return message.content;
  return JSON.stringify(message.content);
}

function truthTone(truth: TruthState): string {
  if (truth === "wired_registry") {
    return "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent-strong)]";
  }
  return "border-[color:var(--color-danger)] bg-[color:var(--color-danger-soft)] text-[color:var(--color-danger)]";
}

function lifecycleTone(tone: LifecycleState["tone"]): string {
  if (tone === "ok") return "border-[color:var(--color-success)] bg-[color:var(--color-success-soft)]";
  if (tone === "warn") return "border-[color:var(--color-warning)] bg-[color:var(--color-warning-soft)]";
  if (tone === "danger") return "border-[color:var(--color-danger)] bg-[color:var(--color-danger-soft)]";
  return "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]";
}

function ProviderHeader(props: { session?: FridaySessionRecord }) {
  const session = props.session;
  const provider = String(session?.metadata?.provider ?? session?.metadata?.providerId ?? session?.channel ?? "Hub session");
  const lifecycle = session?.status ?? "unknown";
  return (
    <section
      data-ui-component="session-provider-header"
      className="grid gap-4 border-b border-[color:var(--color-border-soft)] px-6 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
    >
      <div className="min-w-0">
        <Link to="/sessions" className="mb-3 inline-flex items-center gap-2 text-xs font-medium text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
          <ArrowLeft className="h-3.5 w-3.5" />
          Sessions
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-2xl font-semibold text-[color:var(--color-text-primary)]">
            {session?.key ?? "Session detail"}
          </h1>
          <span className="rounded-full border border-[color:var(--color-border-soft)] px-2.5 py-1 text-xs text-[color:var(--color-text-secondary)]">
            {provider}
          </span>
          <span className="rounded-full border border-[color:var(--color-border-soft)] px-2.5 py-1 text-xs text-[color:var(--color-text-secondary)]">
            {lifecycle}
          </span>
        </div>
        <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
          Long-form provider session with lifecycle, transcript proof, split diff, and governed native-control truth.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
          <p className="font-semibold text-[color:var(--color-text-primary)]">{session?.messageCount ?? 0}</p>
          <p className="text-[color:var(--color-text-tertiary)]">messages</p>
        </div>
        <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
          <p className="font-semibold text-[color:var(--color-text-primary)]">{session?.contextTotalTokens ?? 0}</p>
          <p className="text-[color:var(--color-text-tertiary)]">tokens</p>
        </div>
        <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
          <p className="font-semibold text-[color:var(--color-text-primary)]">{formatDate(session?.lastActivityAt ?? session?.updatedAt)}</p>
          <p className="text-[color:var(--color-text-tertiary)]">activity</p>
        </div>
      </div>
    </section>
  );
}

function LifecycleStrip() {
  return (
    <section data-ui-component="session-lifecycle-strip" className="px-6 py-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-tertiary)]">Lifecycle</p>
          <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">13 states, no silent done state</h2>
        </div>
        <span className="rounded-full border border-[color:var(--color-border-soft)] px-3 py-1 text-xs text-[color:var(--color-text-secondary)]">
          session_control_native_set / NO-GO
        </span>
      </div>
      <div aria-label="Lifecycle state (13 states)" className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {LIFECYCLE_STATES.map((state) => (
          <div key={state.key} data-lifecycle-state={state.key} className={`rounded-lg border p-3 ${lifecycleTone(state.tone)}`}>
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{state.label}</p>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">{state.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TranscriptProof(props: { messages: FridaySessionMessageRecord[]; loading: boolean }) {
  if (props.loading) {
    return <SkeletonList rows={4} />;
  }
  if (props.messages.length === 0) {
    return (
      <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 text-sm text-[color:var(--color-text-secondary)]">
        No messages returned by the session message API.
      </div>
    );
  }
  return (
    <div data-ui-component="transcript-proof" className="space-y-3">
      {props.messages.map((message) => (
        <article key={message.id} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <span className="font-semibold text-[color:var(--color-text-primary)]">{message.role}</span>
            <span>seq {message.sequence}</span>
            <span>{formatDate(message.occurredAt ?? message.createdAt)}</span>
            <span className="rounded-full border border-[color:var(--color-border-soft)] px-2 py-0.5">{message.memoryExtractStatus}</span>
          </div>
          <MarkdownContent text={messageText(message)} />
          <div className="mt-3 border-l-2 border-[color:var(--color-accent)] pl-3 font-mono text-xs text-[color:var(--color-text-tertiary)]">
            proof line: message {message.id} / tokenCount {message.tokenCount} / durable transcript row
          </div>
        </article>
      ))}
    </div>
  );
}

function SplitDiffWorkbench(props: { session?: FridaySessionRecord }) {
  const metadataKeys = props.session ? Object.keys(props.session.metadata ?? {}) : [];
  return (
    <section data-ui-component="split-diff-workbench" className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
          <MessageSquare className="h-4 w-4 text-[color:var(--color-accent)]" />
          Transcript
        </div>
        <p className="text-xs text-[color:var(--color-text-secondary)]">
          Session rows are loaded through `/v1/sessions/:sessionKey/messages`; this view does not fabricate provider completion.
        </p>
      </div>
      <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
          <Split className="h-4 w-4 text-[color:var(--color-accent)]" />
          Diff + proof
        </div>
        <p className="text-xs text-[color:var(--color-text-secondary)]">
          Metadata keys: {metadataKeys.length > 0 ? metadataKeys.join(", ") : "none returned"}. Diff proof remains receipt-bound, not screenshot-only.
        </p>
      </div>
    </section>
  );
}

function SessionControls() {
  return (
    <section data-ui-component="session-control-row" className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-tertiary)]">Session controls</p>
          <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">Full native control</h2>
        </div>
        <span className="rounded-full border border-[color:var(--color-border-soft)] px-3 py-1 text-xs text-[color:var(--color-text-secondary)]">
          wired_registry !== runtime PASS
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {SESSION_CONTROLS.map((control) => (
          <button
            key={control.label}
            type="button"
            data-actlabel={control.label}
            data-cap={control.capability}
            data-truth={control.truth}
            disabled={control.truth !== "wired_registry"}
            title={`${control.capability} / ${control.truth}`}
            className={`rounded-lg border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70 ${truthTone(control.truth)}`}
          >
            {control.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-[color:var(--color-text-secondary)]">
        Blocked - not executed for every NO-GO control. Approvals are registry-wired, but still require Hub gate and ledger proof before any runtime claim.
      </p>
    </section>
  );
}

export function SessionDetailPage() {
  const { locale } = useAppLocale();
  const params = useParams();
  const sessionKey = params.sessionKey ?? "";

  const sessionQuery = useQuery({
    queryKey: ["session-detail", sessionKey],
    queryFn: () => sessionsApi.get(sessionKey),
    enabled: sessionKey.length > 0,
  });
  const messagesQuery = useQuery({
    queryKey: ["session-detail", sessionKey, "messages"],
    queryFn: () => sessionsApi.listMessages(sessionKey, { limit: 100 }),
    enabled: sessionKey.length > 0,
  });
  const forksQuery = useQuery({
    queryKey: ["session-detail", sessionKey, "forks"],
    queryFn: () => sessionsApi.listForks(sessionKey, { limit: 20 }),
    enabled: sessionKey.length > 0,
  });
  const usageQuery = useQuery({
    queryKey: ["session-detail", sessionKey, "usage"],
    queryFn: () => sessionsApi.getUsage(sessionKey),
    enabled: sessionKey.length > 0,
  });

  const loading = sessionQuery.isLoading || messagesQuery.isLoading;
  const error = sessionQuery.isError || messagesQuery.isError;

  return (
    <main data-ui-screen="desktop-session-detail" className="mx-auto max-w-7xl px-4 py-6 lg:px-6">
      <div className="overflow-hidden rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] shadow-[var(--shadow-floating)]">
        <ProviderHeader session={sessionQuery.data} />
        <LifecycleStrip />
        <section className="grid gap-6 px-6 pb-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            {error ? (
              <div className="rounded-lg border border-[color:var(--color-danger)] bg-[color:var(--color-danger-soft)] p-4 text-sm text-[color:var(--color-danger)]">
                {localize(locale, "加载会话详情失败。", "Failed to load session detail.")}
              </div>
            ) : (
              <TranscriptProof messages={messagesQuery.data ?? []} loading={loading} />
            )}
            <SplitDiffWorkbench session={sessionQuery.data} />
            <SessionControls />
          </div>
          <aside className="space-y-3">
            <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
                <ShieldCheck className="h-4 w-4 text-[color:var(--color-accent)]" />
                Capability truth
              </div>
              <p className="text-xs text-[color:var(--color-text-secondary)]">
                security_approval_bound_principal_gate_cat10_netnew / wired_registry. session_control_native_set and provider_adapter_parity_codex_claude / NO-GO.
              </p>
            </div>
            <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
                <GitBranch className="h-4 w-4 text-[color:var(--color-accent)]" />
                Forks
              </div>
              <p className="text-xs text-[color:var(--color-text-secondary)]">{forksQuery.data?.length ?? 0} fork rows returned.</p>
            </div>
            <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
                <TerminalSquare className="h-4 w-4 text-[color:var(--color-accent)]" />
                Usage
              </div>
              <p className="text-xs text-[color:var(--color-text-secondary)]">
                {usageQuery.data ? `${usageQuery.data.totalRuns} runs / ${usageQuery.data.totalInputTokens + usageQuery.data.totalOutputTokens} tokens` : "usage proof not returned"}
              </p>
            </div>
            <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
                <History className="h-4 w-4 text-[color:var(--color-accent)]" />
                Proof boundary
              </div>
              <p className="text-xs text-[color:var(--color-text-secondary)]">
                This screen is a served UI surface and API reader. It does not claim provider completion, operator visual attestation, or END-BAR.
              </p>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
