import { Link } from "react-router-dom";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import {
  buildMarketplaceAssistantCards,
  buildMarketplaceHref,
  summarizeCreatorSupport,
  summarizeMarketplaceRequestState,
} from "@/lib/marketplace/view-models";
import type {
  FridayCreatorProfile,
  FridayMarketplaceAssetKind,
  FridayMarketplaceRequestPost,
} from "@/lib/api/marketplace";
import type { FridayBeginnerIntentResolution } from "@/lib/api/system-types";

function splitSeedList(value: string): string[] {
  return value
    .split(/,|;|\band\b/gi)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractSection(goal: string, label: "constraints" | "risk" | "budget"): string | null {
  const pattern = new RegExp(`${label}\\s*:\\s*([^\\n.]+)`, "i");
  const match = goal.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function deriveAssistantRequestGoal(goal?: string): string {
  if (!goal) {
    return "";
  }
  return goal
    .replace(/\s+constraints\s*:\s*[^.\n]+/gi, "")
    .replace(/\s+risk\s*:\s*[^.\n]+/gi, "")
    .replace(/\s+budget\s*:\s*[^.\n]+/gi, "")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+\./g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveAssistantRequestConstraints(
  goal?: string,
  intentResult?: FridayBeginnerIntentResolution | null,
): string[] {
  const constraints = new Set<string>();
  const rawGoal = goal ?? "";
  const explicitConstraints = extractSection(rawGoal, "constraints");
  for (const entry of explicitConstraints ? splitSeedList(explicitConstraints) : []) {
    constraints.add(entry);
  }
  if (/read[- ]only/i.test(rawGoal)) {
    constraints.add("read-only");
  }
  if (/no outbound network access/i.test(rawGoal)) {
    constraints.add("no outbound network access");
  }
  if (/no production writes?/i.test(rawGoal)) {
    constraints.add("no production writes");
  }
  if (/no destructive actions?/i.test(rawGoal)) {
    constraints.add("no destructive actions");
  }
  for (const assumption of intentResult?.assumptions ?? []) {
    if (assumption.trim().length > 0) {
      constraints.add(assumption.trim());
    }
  }
  return [...constraints];
}

function deriveAssistantRequestRiskNotes(
  goal?: string,
  intentResult?: FridayBeginnerIntentResolution | null,
): string | null {
  return extractSection(goal ?? "", "risk") ?? intentResult?.fallbackPath ?? null;
}

function deriveAssistantBudgetSupportIntent(goal?: string): string | null {
  const explicitBudget = extractSection(goal ?? "", "budget");
  if (explicitBudget) {
    return explicitBudget;
  }
  const inlineBudget = goal?.match(/\$\d+\s*(?:tip|support|budget)/i)?.[0];
  return inlineBudget?.trim() ?? null;
}

function buildAssistantMarketplaceRequestHref(input: {
  requestKind: FridayMarketplaceAssetKind;
  goalSeed?: string;
  intentResult?: FridayBeginnerIntentResolution | null;
}): string {
  const goal = input.goalSeed?.trim() || input.intentResult?.objective?.trim() || "";
  const structuredGoal = deriveAssistantRequestGoal(goal) || goal;
  const assetLabel =
    input.requestKind === "workflow" || input.requestKind === "agent"
      ? input.requestKind
      : "skill";

  return buildMarketplaceHref({
    requestKind: input.requestKind,
    goal,
    title: structuredGoal ? `Need a ${assetLabel} for: ${structuredGoal}` : undefined,
    desiredOutcome: structuredGoal
      ? `A usable ${assetLabel} that solves: ${structuredGoal}`
      : undefined,
    constraints: deriveAssistantRequestConstraints(goal, input.intentResult),
    riskNotes: deriveAssistantRequestRiskNotes(goal, input.intentResult),
    budgetSupportIntent: deriveAssistantBudgetSupportIntent(goal),
  });
}

function compactText(text?: string): string {
  if (!text) {
    return "No summary yet.";
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function mapTone(
  value?: string,
): "neutral" | "success" | "warning" | "danger" {
  if (!value) return "neutral";
  if (["healthy", "completed", "active", "ready", "verified", "ok", "paired", "online"].includes(value)) {
    return "success";
  }
  if (["blocked", "warning", "degraded", "safe_mode", "paused", "needs_one_answer"].includes(value)) {
    return "warning";
  }
  if (["failed", "error", "danger", "out_of_boundary", "revoked", "offline"].includes(value)) {
    return "danger";
  }
  return "neutral";
}

interface MarketplaceActionCardProps {
  marketplaceCards: ReturnType<typeof buildMarketplaceAssistantCards>;
  creators: FridayCreatorProfile[];
  requests: FridayMarketplaceRequestPost[];
  goalSeed?: string;
  intentResult?: FridayBeginnerIntentResolution | null;
  onInstallSkill: (skillId: string, sourceId?: string) => void;
  onSupportAsset: (assetId: string) => void;
  installPending: boolean;
  supportPending: boolean;
}

export function MarketplaceActionCard(props: MarketplaceActionCardProps) {
  const requestSummary = summarizeMarketplaceRequestState(props.requests);
  const creatorSummary = summarizeCreatorSupport(props.creators);

  return (
    <section className="rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5 shadow-[var(--shadow-floating)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            Marketplace
          </p>
          <h3 className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
            Install safely, support creators, or post a request
          </h3>
        </div>
        <Link
          className="text-sm text-[color:var(--color-accent)] transition hover:opacity-80"
          data-testid="assistant-marketplace-open-all"
          to={buildMarketplaceHref()}
        >
          Open all
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MarketplaceMetric label="Public assets" value={String(props.marketplaceCards.length)} />
        <MarketplaceMetric label="Creators" value={String(creatorSummary.creatorCount)} />
        <MarketplaceMetric
          label="Open requests"
          value={String(requestSummary.openCount)}
          tone={requestSummary.openCount > 0 ? "warning" : "neutral"}
        />
      </div>

      <div className="mt-4 space-y-3">
        {props.marketplaceCards.map((asset) => (
          <div
            key={asset.assetId}
            className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-[color:var(--color-text-primary)]">{asset.title}</h4>
                <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                  {asset.assetType} · {asset.publisherName}
                </p>
              </div>
              <StatusPill tone={asset.installable ? "success" : mapTone(asset.maturity)}>
                {asset.installable ? "install ready" : asset.maturity.replaceAll("_", " ")}
              </StatusPill>
            </div>
            <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">{compactText(asset.summary)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)]"
                data-testid={`assistant-marketplace-open-${asset.assetId}`}
                to={buildMarketplaceHref({ assetId: asset.assetId })}
              >
                Open in marketplace
              </Link>
              {asset.installable ? (
                <ActionButton
                  data-testid={`assistant-marketplace-install-${asset.assetId}`}
                  disabled={props.installPending}
                  onClick={() => props.onInstallSkill(asset.assetId.replace(/^skill:/, ""))}
                >
                  Install
                </ActionButton>
              ) : null}
              <ActionButton
                data-testid={`assistant-marketplace-support-${asset.assetId}`}
                tone="secondary"
                disabled={props.supportPending}
                onClick={() => props.onSupportAsset(asset.assetId)}
              >
                Support creator
              </ActionButton>
            </div>
          </div>
        ))}

        <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-[color:var(--color-text-primary)]">No fit? Post a custom request</h4>
              <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                {creatorSummary.creatorCount} creators · {creatorSummary.verifiedCount} verified
              </p>
            </div>
            <StatusPill tone="warning">{requestSummary.openCount} open</StatusPill>
          </div>
          <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
            Ask the ecosystem for a personal skill, workflow, or agent when the catalog does not solve your goal cleanly.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              className="inline-flex min-h-[44px] items-center justify-center rounded-2xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-bg-base)] transition hover:opacity-90"
              data-testid="assistant-marketplace-request-skill"
              to={buildAssistantMarketplaceRequestHref({
                requestKind: "skill",
                goalSeed: props.goalSeed,
                intentResult: props.intentResult,
              })}
            >
              Post skill request
            </Link>
            <Link
              className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)]"
              data-testid="assistant-marketplace-request-workflow"
              to={buildAssistantMarketplaceRequestHref({
                requestKind: "workflow",
                goalSeed: props.goalSeed,
                intentResult: props.intentResult,
              })}
            >
              Post workflow request
            </Link>
            <Link
              className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)]"
              data-testid="assistant-marketplace-request-agent"
              to={buildAssistantMarketplaceRequestHref({
                requestKind: "agent",
                goalSeed: props.goalSeed,
                intentResult: props.intentResult,
              })}
            >
              Post agent request
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function MarketplaceMetric(props: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">{props.label}</p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xl font-semibold text-[color:var(--color-text-primary)]">{props.value}</p>
        <StatusPill tone={props.tone}>{props.tone ?? "active"}</StatusPill>
      </div>
    </div>
  );
}
