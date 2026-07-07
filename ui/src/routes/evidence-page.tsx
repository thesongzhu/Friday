import { type FormEvent, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCheck2, FileJson, GitCompare, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import {
  taskWorkflowsApi,
  type TaskWorkflowClaimKind,
  type TaskWorkflowEvidenceExplorerEntry,
  type TaskWorkflowEvidenceRawDrilldown,
} from "@/lib/api/task-workflows";

type ReceiptLane = {
  claimKind: TaskWorkflowClaimKind;
  title: string;
  description: string;
};

const RECEIPT_LANES: ReceiptLane[] = [
  {
    claimKind: "runtime_evidence",
    title: "Runtime receipts",
    description: "Runtime rows need a live execution ref before they can support a runtime claim.",
  },
  {
    claimKind: "code_evidence",
    title: "Code receipts",
    description: "Code receipts prove source or diff linkage; receipt hash is not execution proof.",
  },
  {
    claimKind: "api_evidence",
    title: "API receipts",
    description: "API evidence must still bind request, response, actor, and verdict.",
  },
  {
    claimKind: "artifact_evidence",
    title: "Artifact receipts",
    description: "Artifacts stay inspectable, server-redacted, and separate from runtime PASS.",
  },
];

function formatTimestamp(value?: string | null): string {
  if (!value) return "unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusTone(status: TaskWorkflowEvidenceExplorerEntry["claimStatus"]): "neutral" | "success" | "warning" | "danger" {
  if (status === "verified") return "success";
  if (status === "blocked") return "danger";
  if (status === "draft" || status === "unverified") return "warning";
  return "neutral";
}

function filterEvidence(
  entries: readonly TaskWorkflowEvidenceExplorerEntry[],
  query: string,
): TaskWorkflowEvidenceExplorerEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) => [
    entry.evidenceRefId,
    entry.workflowId,
    entry.claimId,
    entry.refKind,
    entry.refSource,
    entry.refHash ?? "",
    entry.claimStatus,
    entry.claimKind,
  ].some((value) => value.toLowerCase().includes(needle)));
}

function laneEntries(entries: readonly TaskWorkflowEvidenceExplorerEntry[], claimKind: TaskWorkflowClaimKind) {
  return entries.filter((entry) => entry.claimKind === claimKind);
}

function hashLabel(hash?: string | null): string {
  return hash ? `${hash.slice(0, 12)}...` : "hash pending";
}

function EvidenceSearch(props: {
  query: string;
  workflowId: string;
  onQueryChange: (value: string) => void;
  onWorkflowIdChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onSubmit();
  };
  return (
    <form data-ui-component="evidence-search" onSubmit={submit} className="grid gap-3 rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.6fr)_auto]">
      <label className="min-w-0 text-sm">
        <span className="mb-1 block font-medium text-[color:var(--color-text-primary)]">Search evidence refs</span>
        <div className="flex min-h-[40px] items-center gap-2 rounded-md border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-3">
          <Search className="h-4 w-4 shrink-0 text-[color:var(--color-text-tertiary)]" />
          <input
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder="ref id, workflow, claim, hash, source"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
      </label>
      <label className="min-w-0 text-sm">
        <span className="mb-1 block font-medium text-[color:var(--color-text-primary)]">Workflow filter</span>
        <input
          value={props.workflowId}
          onChange={(event) => props.onWorkflowIdChange(event.target.value)}
          placeholder="optional workflowId"
          className="min-h-[40px] w-full rounded-md border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-3 text-sm outline-none"
        />
      </label>
      <ActionButton type="submit" className="self-end" disabled={props.loading}>
        <RefreshCw className="mr-2 h-4 w-4" />
        Refresh
      </ActionButton>
    </form>
  );
}

function ReceiptLanes(props: {
  entries: readonly TaskWorkflowEvidenceExplorerEntry[];
  onSelect: (entry: TaskWorkflowEvidenceExplorerEntry) => void;
  selectedRefId?: string | null;
}) {
  return (
    <section data-ui-component="evidence-receipt-lanes" className="grid gap-3 xl:grid-cols-4">
      {RECEIPT_LANES.map((lane) => {
        const entries = laneEntries(props.entries, lane.claimKind);
        return (
          <article key={lane.claimKind} data-claim-kind={lane.claimKind} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-tertiary)]">{lane.claimKind}</p>
                <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">{lane.title}</h2>
              </div>
              <StatusPill tone={entries.length > 0 ? "success" : "warning"}>{entries.length}</StatusPill>
            </div>
            <p className="mb-3 text-xs leading-5 text-[color:var(--color-text-secondary)]">{lane.description}</p>
            <div className="space-y-2">
              {entries.slice(0, 4).map((entry) => (
                <button
                  key={entry.evidenceRefId}
                  type="button"
                  onClick={() => props.onSelect(entry)}
                  className="w-full rounded-md border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] p-3 text-left text-xs hover:border-[color:var(--color-border-strong)]"
                  data-selected={props.selectedRefId === entry.evidenceRefId ? "true" : "false"}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[color:var(--color-text-primary)]">{entry.refKind}</span>
                    <StatusPill tone={statusTone(entry.claimStatus)}>{entry.claimStatus}</StatusPill>
                  </div>
                  <div className="truncate text-[color:var(--color-text-tertiary)]">{entry.refSource} / {hashLabel(entry.refHash)}</div>
                </button>
              ))}
              {entries.length === 0 ? (
                <div className="rounded-md border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] p-3 text-xs text-[color:var(--color-text-tertiary)]">
                  NO-GO: no indexed receipt in this lane.
                </div>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function EvidenceTable(props: {
  entries: readonly TaskWorkflowEvidenceExplorerEntry[];
  onSelect: (entry: TaskWorkflowEvidenceExplorerEntry) => void;
}) {
  return (
    <section className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]">
      <div className="border-b border-[color:var(--color-border-soft)] px-4 py-3">
        <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">Evidence index</h2>
        <p className="text-xs text-[color:var(--color-text-secondary)]">Metadata index only; raw values stay behind explicit server-redacted drilldown.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.08em] text-[color:var(--color-text-tertiary)]">
            <tr>
              <th className="px-4 py-3">Ref kind</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Claim</th>
              <th className="px-4 py-3">Hash</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Inspect</th>
            </tr>
          </thead>
          <tbody>
            {props.entries.map((entry) => (
              <tr key={entry.evidenceRefId} className="border-t border-[color:var(--color-border-soft)]">
                <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-text-primary)]">{entry.refKind}</td>
                <td className="px-4 py-3 text-xs text-[color:var(--color-text-secondary)]">{entry.refSource}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[color:var(--color-text-secondary)]">{entry.claimKind}</span>
                    <StatusPill tone={statusTone(entry.claimStatus)}>{entry.claimStatus}</StatusPill>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-text-secondary)]">{hashLabel(entry.refHash)}</td>
                <td className="px-4 py-3 text-xs text-[color:var(--color-text-secondary)]">{formatTimestamp(entry.createdAt)}</td>
                <td className="px-4 py-3">
                  <ActionButton tone="secondary" className="min-h-[34px] px-3 py-1 text-xs" onClick={() => props.onSelect(entry)}>
                    Inspect
                  </ActionButton>
                </td>
              </tr>
            ))}
            {props.entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-[color:var(--color-text-tertiary)]">
                  NO-GO: no indexed evidence matches this search.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvidenceInspector(props: {
  selected?: TaskWorkflowEvidenceExplorerEntry | null;
  drilldown?: TaskWorkflowEvidenceRawDrilldown | null;
  loading: boolean;
}) {
  const selected = props.selected;
  return (
    <aside data-ui-component="evidence-inspector" className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-tertiary)]">Inspector</p>
          <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">Raw evidence gate</h2>
        </div>
        <ShieldAlert className="h-5 w-5 text-[color:var(--color-text-tertiary)]" />
      </div>
      {!selected ? (
        <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
          Select a receipt lane row to request the gated raw drilldown. The API returns only server-redacted refs.
        </p>
      ) : (
        <div className="space-y-3 text-sm">
          <div>
            <p className="text-xs text-[color:var(--color-text-tertiary)]">Selected ref</p>
            <p className="break-all font-mono text-xs text-[color:var(--color-text-primary)]">{selected.evidenceRefId}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <StatusPill tone={statusTone(selected.claimStatus)}>{selected.claimStatus}</StatusPill>
            <StatusPill tone="warning">same SHA != runtime PASS</StatusPill>
          </div>
          {props.loading ? <p className="text-xs text-[color:var(--color-text-secondary)]">Loading server-redacted drilldown...</p> : null}
          {props.drilldown ? (
            <div className="space-y-2 rounded-md border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] p-3 text-xs">
              <div>refIdRedacted: <code>{props.drilldown.refIdRedacted}</code></div>
              <div>redactionApplied: <code>{String(props.drilldown.redactionApplied)}</code></div>
              <div>refHash: <code>{hashLabel(props.drilldown.refHash)}</code></div>
              <div>source: <code>{props.drilldown.refSource}</code></div>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function SplitDiff(props: {
  selected?: TaskWorkflowEvidenceExplorerEntry | null;
  drilldown?: TaskWorkflowEvidenceRawDrilldown | null;
}) {
  return (
    <section data-ui-component="evidence-split-diff" className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
          <FileCheck2 className="h-4 w-4 text-[color:var(--color-accent)]" />
          Indexed receipt
        </div>
        <p className="break-all font-mono text-xs text-[color:var(--color-text-secondary)]">
          {props.selected ? props.selected.evidenceRefId : "select a receipt"}
        </p>
        <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
          {props.selected ? `hash ${hashLabel(props.selected.refHash)}` : "receipt hash pending"}
        </p>
      </div>
      <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
          <GitCompare className="h-4 w-4 text-[color:var(--color-accent)]" />
          Redacted drilldown
        </div>
        <p className="break-all font-mono text-xs text-[color:var(--color-text-secondary)]">
          {props.drilldown ? props.drilldown.refIdRedacted : "server-redacted drilldown not loaded"}
        </p>
        <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
          receipt hash is not execution proof; same SHA != runtime PASS.
        </p>
      </div>
    </section>
  );
}

export function EvidencePage() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [submittedWorkflowId, setSubmittedWorkflowId] = useState("");
  const [selected, setSelected] = useState<TaskWorkflowEvidenceExplorerEntry | null>(null);
  const [drilldown, setDrilldown] = useState<TaskWorkflowEvidenceRawDrilldown | null>(null);
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const evidenceQuery = useQuery({
    queryKey: ["desktop-evidence", submittedWorkflowId],
    queryFn: () =>
      taskWorkflowsApi.queryEvidence({
        workflowId: submittedWorkflowId.trim().length > 0 ? submittedWorkflowId.trim() : undefined,
        limit: 100,
      }),
  });

  const entries = useMemo(
    () => filterEvidence(evidenceQuery.data ?? [], submittedQuery),
    [evidenceQuery.data, submittedQuery],
  );

  const refresh = () => {
    setSubmittedQuery(query);
    setSubmittedWorkflowId(workflowId);
  };

  const inspect = async (entry: TaskWorkflowEvidenceExplorerEntry) => {
    setSelected(entry);
    setDrilldown(null);
    const confirmed = window.confirm(
      "Raw evidence may contain sensitive fields. Friday returns server-redacted refs only. Continue?",
    );
    if (!confirmed) return;
    try {
      setDrilldownLoading(true);
      const result = await taskWorkflowsApi.getEvidenceRawDrilldown(entry.evidenceRefId);
      setDrilldown(result);
    } catch (error) {
      toast.error("Failed to open server-redacted evidence drilldown.");
    } finally {
      setDrilldownLoading(false);
    }
  };

  return (
    <main data-ui-screen="desktop-evidence" className="min-h-full bg-[color:var(--color-bg-base)]">
      <section className="border-b border-[color:var(--color-border-soft)] px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-tertiary)]">Evidence</p>
            <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-text-primary)]">Receipt workbench</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
              Search indexed evidence refs, inspect four receipt lanes, and compare redacted drilldown metadata without upgrading receipts into runtime PASS.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="warning">NO-GO when evidence is missing</StatusPill>
            <StatusPill tone="neutral">wired registry is not runtime proof</StatusPill>
          </div>
        </div>
      </section>
      <section className="grid gap-4 px-6 py-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <EvidenceSearch
            query={query}
            workflowId={workflowId}
            onQueryChange={setQuery}
            onWorkflowIdChange={setWorkflowId}
            onSubmit={refresh}
            loading={evidenceQuery.isFetching}
          />
          <ReceiptLanes entries={entries} onSelect={inspect} selectedRefId={selected?.evidenceRefId} />
          <EvidenceTable entries={entries} onSelect={inspect} />
          <SplitDiff selected={selected} drilldown={drilldown} />
        </div>
        <div className="space-y-4">
          <EvidenceInspector selected={selected} drilldown={drilldown} loading={drilldownLoading} />
          <section className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 text-sm leading-6 text-[color:var(--color-text-secondary)]">
            <div className="mb-2 flex items-center gap-2 font-semibold text-[color:var(--color-text-primary)]">
              <FileJson className="h-4 w-4 text-[color:var(--color-accent)]" />
              Proof boundary
            </div>
            <p>
              Same hash, same ref kind, or successful redaction does not prove the underlying action executed. Runtime PASS requires a separate live execution receipt.
            </p>
          </section>
        </div>
      </section>
    </main>
  );
}
