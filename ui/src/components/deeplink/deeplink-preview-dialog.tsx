import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiClient } from "@/lib/api/client";

interface DeepLinkCheck {
  id: string;
  label: string;
  level: "blocking" | "warning" | "advisory";
  summary: string;
}

interface DeepLinkPreviewResult {
  valid: boolean;
  verdict: "ready" | "needs_review" | "blocked";
  checks: DeepLinkCheck[];
  permissionSummary: string[];
  payload: {
    type: string;
    label: string;
  };
}

interface DeepLinkPreviewResponse {
  preview: DeepLinkPreviewResult;
}

interface DeepLinkApplyResponse {
  result: {
    applied: boolean;
    resourceType: string;
    resourceId?: string;
    workflowId?: string;
    resourceUrl?: string;
    message: string;
  };
}

type DeepLinkRequestBody =
  | { uri: string; confirmed?: boolean }
  | { payload: unknown; confirmed?: boolean };

function buildDeepLinkRequestBody(input: string, confirmed?: boolean): DeepLinkRequestBody {
  const trimmed = input.trim();
  const base = trimmed.startsWith("friday://")
    ? { uri: trimmed }
    : { payload: JSON.parse(trimmed) };
  return confirmed === true ? { ...base, confirmed: true } : base;
}

function checkLevelBadge(level: string) {
  switch (level) {
    case "blocking":
      return <span className="rounded-full bg-[color:var(--danger-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--danger)]">Blocking</span>;
    case "warning":
      return <span className="rounded-full bg-[color:var(--warn-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--warn)]">Warning</span>;
    default:
      return <span className="rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-accent)]">Advisory</span>;
  }
}

export function DeepLinkPreviewDialog(props: { onClose: () => void; onApplied?: () => void }) {
  const navigate = useNavigate();
  const [uri, setUri] = useState("");
  const [preview, setPreview] = useState<DeepLinkPreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<DeepLinkApplyResponse["result"] | null>(null);

  const previewMutation = useMutation({
    mutationFn: async (input: string) => {
      const body = buildDeepLinkRequestBody(input);
      const data = await apiClient.post<typeof body, DeepLinkPreviewResponse>("/v1/deeplink/preview", body);
      return data.preview;
    },
    onSuccess: (data) => setPreview(data),
  });
  const applyMutation = useMutation({
    mutationFn: async (input: string) => {
      const body = buildDeepLinkRequestBody(input, true);
      const data = await apiClient.post<typeof body, DeepLinkApplyResponse>("/v1/deeplink/apply", body);
      return data.result;
    },
    onSuccess: (result) => {
      setApplyResult(result);
      if (result.resourceType === "workflow-template" && result.resourceUrl) {
        navigate(result.resourceUrl);
      }
      props.onApplied?.();
    },
  });
  const canApplyFromUi = preview?.valid === true && preview.payload.type === "workflow-template";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={props.onClose} role="presentation">
      <div
        className="mx-4 w-full max-w-lg rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Import from URL"
      >
        <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">Import from URL</h2>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          Paste a <code className="rounded bg-[color:var(--color-bg-subtle)] px-1 text-[color:var(--color-text-primary)]">friday://</code> deep link or a JSON payload to preview it before importing.
        </p>

        <textarea
          className="mt-4 w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] p-3 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
          rows={3}
          placeholder="friday://skill-source?url=https://github.com/user/repo"
          value={uri}
          onChange={(e) => { setUri(e.target.value); setPreview(null); setApplyResult(null); }}
        />

        {previewMutation.error ? (
          <p className="mt-2 text-xs text-[color:var(--danger)]">
            {previewMutation.error instanceof Error ? previewMutation.error.message : "Preview failed"}
          </p>
        ) : null}
        {applyMutation.error ? (
          <p className="mt-2 text-xs text-[color:var(--danger)]">
            {applyMutation.error instanceof Error ? applyMutation.error.message : "Import failed"}
          </p>
        ) : null}

        {!preview ? (
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={props.onClose} className="rounded-xl border border-[color:var(--color-border-soft)] px-4 py-2 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]">Cancel</button>
            <button
              type="button"
              onClick={() => previewMutation.mutate(uri)}
              disabled={!uri.trim() || previewMutation.isPending}
              className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)] disabled:opacity-50"
            >
              {previewMutation.isPending ? "Previewing..." : "Preview"}
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[color:var(--color-text-primary)]">{preview.payload.label}</span>
              {preview.verdict === "ready" ? (
                <span className="rounded-full bg-[color:var(--ok-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--ok)]">Ready</span>
              ) : preview.verdict === "needs_review" ? (
                <span className="rounded-full bg-[color:var(--warn-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--warn)]">Needs Review</span>
              ) : (
                <span className="rounded-full bg-[color:var(--danger-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--danger)]">Blocked</span>
              )}
            </div>

            {preview.checks.length > 0 ? (
              <div className="space-y-1">
                {preview.checks.map((check) => (
                  <div key={check.id} className="flex items-start gap-2 text-xs">
                    {checkLevelBadge(check.level)}
                    <span className="text-[color:var(--color-text-secondary)]">{check.summary}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {preview.permissionSummary.length > 0 ? (
              <div className="rounded-lg bg-[color:var(--color-bg-base)] p-2">
                <p className="text-xs font-medium text-[color:var(--color-text-primary)]">Permissions</p>
                <ul className="mt-1 list-inside list-disc text-xs text-[color:var(--color-text-secondary)]">
                  {preview.permissionSummary.map((perm, i) => (
                    <li key={i}>{perm}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {applyResult ? (
              <div className="rounded-lg border border-[color:var(--ok-soft)] bg-[color:var(--ok-soft)] p-2 text-xs text-[color:var(--ok)]">
                {applyResult.message}
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={props.onClose} className="rounded-xl border border-[color:var(--color-border-soft)] px-4 py-2 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]">Cancel</button>
              <button
                type="button"
                disabled={!canApplyFromUi || applyMutation.isPending || Boolean(applyResult)}
                onClick={() => applyMutation.mutate(uri)}
                className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)] disabled:opacity-50"
              >
                {preview.payload.type === "workflow-template"
                  ? applyMutation.isPending
                    ? "Importing..."
                    : "Import Draft"
                  : "Approval Required"}
              </button>
            </div>

            <p className="text-xs text-[color:var(--color-text-tertiary)]">
              Skill and provider imports require canonical approval before staging or writing. Workflow templates import as drafts only and require review confirmation before publish, deploy, or run.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
