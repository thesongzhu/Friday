import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
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
    message: string;
  };
}

function checkLevelBadge(level: string) {
  switch (level) {
    case "blocking":
      return <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 ">Blocking</span>;
    case "warning":
      return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 ">Warning</span>;
    default:
      return <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-600 ">Advisory</span>;
  }
}

export function DeepLinkPreviewDialog(props: { onClose: () => void; onApplied?: () => void }) {
  const [uri, setUri] = useState("");
  const [preview, setPreview] = useState<DeepLinkPreviewResult | null>(null);

  const previewMutation = useMutation({
    mutationFn: async (input: string) => {
      const body = input.startsWith("friday://") ? { uri: input } : { payload: JSON.parse(input) };
      const data = await apiClient.post<typeof body, DeepLinkPreviewResponse>("/v1/deeplink/preview", body);
      return data.preview;
    },
    onSuccess: (data) => setPreview(data),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const body = uri.startsWith("friday://")
        ? { uri, confirmed: true }
        : { payload: JSON.parse(uri), confirmed: true };
      return apiClient.post<typeof body, DeepLinkApplyResponse>("/v1/deeplink/apply", body);
    },
    onSuccess: () => {
      props.onApplied?.();
      props.onClose();
    },
  });

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
          Paste a <code className="rounded bg-zinc-100 px-1 ">friday://</code> deep link or a JSON payload to preview and import.
        </p>

        <textarea
          className="mt-4 w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] p-3 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
          rows={3}
          placeholder="friday://skill-source?url=https://github.com/user/repo"
          value={uri}
          onChange={(e) => { setUri(e.target.value); setPreview(null); }}
        />

        {previewMutation.error ? (
          <p className="mt-2 text-xs text-red-600 ">
            {previewMutation.error instanceof Error ? previewMutation.error.message : "Preview failed"}
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
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 ">Ready</span>
              ) : preview.verdict === "needs_review" ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 ">Needs Review</span>
              ) : (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 ">Blocked</span>
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

            <div className="flex justify-end gap-2">
              <button type="button" onClick={props.onClose} className="rounded-xl border border-[color:var(--color-border-soft)] px-4 py-2 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]">Cancel</button>
              <button
                type="button"
                onClick={() => applyMutation.mutate()}
                disabled={preview.verdict === "blocked" || applyMutation.isPending}
                className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)] disabled:opacity-50"
              >
                {applyMutation.isPending ? "Importing..." : "Confirm Import"}
              </button>
            </div>

            {applyMutation.error ? (
              <p className="text-xs text-red-600 ">
                {applyMutation.error instanceof Error ? applyMutation.error.message : "Import failed"}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
