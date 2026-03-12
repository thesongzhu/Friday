import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift, PackagePlus, ShieldCheck, Sparkles, Users, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, FieldLabel, ShellCard, StatusPill } from "@/components/core/primitives";
import { marketplaceApi, type FridayMarketplaceAssetKind } from "@/lib/api/marketplace";
import { skillsApi } from "@/lib/api/skills";
import { buildSkillHref } from "@/lib/skills/view-models";

function compactText(value?: string | null): string {
  if (!value) return "No summary yet.";
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function formatMoney(amount?: { amount: number; currency: string }): string {
  if (!amount) return "0";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: amount.currency,
    maximumFractionDigits: 2,
  }).format(amount.amount / 100);
}

function toneForMaturity(
  maturity?: "validated_and_keep" | "validated_but_temporary" | "deferred",
): "neutral" | "success" | "warning" | "danger" {
  if (maturity === "validated_and_keep") return "success";
  if (maturity === "validated_but_temporary") return "warning";
  if (maturity === "deferred") return "danger";
  return "neutral";
}

function MarketplaceMetric(props: { label: string; value: string; detail: string }) {
  return (
    <div className="agent-metric-card">
      <p className="text-2xl font-semibold text-white">{props.value}</p>
      <p className="mt-3 text-sm font-medium text-white">{props.label}</p>
      <p className="mt-1 text-xs leading-5 text-white/50">{props.detail}</p>
    </div>
  );
}

export function MarketplacePage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [requestAssetKind, setRequestAssetKind] = useState<FridayMarketplaceAssetKind>("skill");
  const [expandedPermissionAssetId, setExpandedPermissionAssetId] = useState<string | null>(null);
  const [requestTitle, setRequestTitle] = useState("");
  const [requestGoal, setRequestGoal] = useState("");
  const [requestOutcome, setRequestOutcome] = useState("");
  const [requestConstraints, setRequestConstraints] = useState("");
  const [requestBudget, setRequestBudget] = useState("");
  const [requestRiskNotes, setRequestRiskNotes] = useState("");
  const [requestResponseDrafts, setRequestResponseDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const assetId = searchParams.get("asset");
    const requestKind = searchParams.get("requestKind");
    const seededGoal = searchParams.get("goal");

    if (assetId) {
      setExpandedPermissionAssetId(assetId);
    }
    if (requestKind === "skill" || requestKind === "workflow" || requestKind === "agent") {
      setRequestAssetKind(requestKind);
    }
    if (seededGoal) {
      setRequestGoal((current) => current || seededGoal);
      setRequestTitle((current) =>
        current || `Need a ${requestKind === "workflow" || requestKind === "agent" ? requestKind : "skill"} for: ${seededGoal.slice(0, 48)}`,
      );
      setRequestOutcome((current) =>
        current || `A usable ${requestKind === "workflow" || requestKind === "agent" ? requestKind : "skill"} that solves: ${seededGoal}`,
      );
    }
  }, [searchParams]);

  const assetsQuery = useQuery({
    queryKey: ["marketplace", "assets"],
    queryFn: () => marketplaceApi.listAssets(),
    refetchInterval: 30_000,
  });

  const creatorsQuery = useQuery({
    queryKey: ["marketplace", "creators"],
    queryFn: () => marketplaceApi.listCreators(),
    refetchInterval: 30_000,
  });

  const requestsQuery = useQuery({
    queryKey: ["marketplace", "requests"],
    queryFn: () => marketplaceApi.listRequests(),
    refetchInterval: 30_000,
  });

  const assets = assetsQuery.data ?? [];
  const creators = creatorsQuery.data ?? [];
  const requests = requestsQuery.data ?? [];
  const openRequests = useMemo(
    () => requests.filter((entry) => entry.status !== "closed").slice(0, 6),
    [requests],
  );
  const featuredAssets = useMemo(
    () => assets.filter((entry) => entry.publicEligible).slice(0, 6),
    [assets],
  );
  const featuredDetails = useQueries({
    queries: featuredAssets.map((asset) => ({
      queryKey: ["marketplace", "asset", asset.assetId],
      queryFn: () => marketplaceApi.getAsset(asset.assetId),
      staleTime: 30_000,
    })),
  });
  const requestBundles = useQueries({
    queries: openRequests.map((request) => ({
      queryKey: ["marketplace", "request", request.id],
      queryFn: () => marketplaceApi.getRequest(request.id),
      staleTime: 30_000,
    })),
  });

  const installSkillMutation = useMutation({
    mutationFn: (input: { skillId: string }) => skillsApi.installSkill({ skillId: input.skillId }),
    onSuccess: (result) => {
      toast.success(`Installed ${result.skill.name}.`);
      void queryClient.invalidateQueries({ queryKey: ["marketplace"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not install asset");
    },
  });

  const supportMutation = useMutation({
    mutationFn: (assetId: string) =>
      marketplaceApi.supportAsset(assetId, {
        amount: { amount: 500, currency: "USD" },
        message: "Thanks for building this.",
      }),
    onSuccess: () => {
      toast.success("Support sent to the creator.");
      void queryClient.invalidateQueries({ queryKey: ["marketplace", "creators"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not send support");
    },
  });

  const createRequestMutation = useMutation({
    mutationFn: () =>
      marketplaceApi.createRequest({
        assetKind: requestAssetKind,
        title: requestTitle.trim(),
        goal: requestGoal.trim(),
        desiredOutcome: requestOutcome.trim(),
        constraints: requestConstraints
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        budgetSupportIntent: requestBudget.trim() || null,
        privacy: "private",
        publishability: "allow_publication",
        riskNotes: requestRiskNotes.trim() || null,
      }),
    onSuccess: (bundle) => {
      toast.success(`Request "${bundle.request.title}" posted.`);
      setRequestTitle("");
      setRequestGoal("");
      setRequestOutcome("");
      setRequestConstraints("");
      setRequestBudget("");
      setRequestRiskNotes("");
      void queryClient.invalidateQueries({ queryKey: ["marketplace", "requests"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not post request");
    },
  });

  const respondMutation = useMutation({
    mutationFn: (input: { requestId: string; message: string }) =>
      marketplaceApi.createRequestResponse(input.requestId, {
        message: input.message,
      }),
    onSuccess: (_, input) => {
      toast.success("Response submitted.");
      setRequestResponseDrafts((current) => ({ ...current, [input.requestId]: "" }));
      void queryClient.invalidateQueries({ queryKey: ["marketplace", "requests"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not respond to request");
    },
  });
  const acceptMutation = useMutation({
    mutationFn: (input: { requestId: string; responseId: string }) =>
      marketplaceApi.acceptRequestResponse(input.requestId, input.responseId),
    onSuccess: (_, input) => {
      toast.success("Request response accepted.");
      void queryClient.invalidateQueries({ queryKey: ["marketplace", "requests"] });
      void queryClient.invalidateQueries({ queryKey: ["marketplace", "request", input.requestId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not accept response");
    },
  });
  const closeMutation = useMutation({
    mutationFn: (requestId: string) => marketplaceApi.closeRequest(requestId),
    onSuccess: (_, requestId) => {
      toast.success("Request closed.");
      void queryClient.invalidateQueries({ queryKey: ["marketplace", "requests"] });
      void queryClient.invalidateQueries({ queryKey: ["marketplace", "request", requestId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not close request");
    },
  });

  const canSubmitRequest =
    requestTitle.trim().length > 0 &&
    requestGoal.trim().length > 0 &&
    requestOutcome.trim().length > 0;

  return (
    <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
      <div className="space-y-4">
        <ShellCard
          eyebrow="Public ecosystem"
          title="Install safely, support creators, or request a custom asset"
          aside={<StatusPill tone="success">0% commission</StatusPill>}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <MarketplaceMetric
              label="Public assets"
              value={String(assets.length)}
              detail="Skills, workflows, and agents with permission-aware previews."
            />
            <MarketplaceMetric
              label="Creators"
              value={String(creators.length)}
              detail="Support creators directly. Friday does not take a platform cut."
            />
            <MarketplaceMetric
              label="Open requests"
              value={String(openRequests.length)}
              detail="Post a personal skill, workflow, or agent request when nothing fits."
            />
          </div>
          <div className="agent-detail-note mt-4 p-4 text-sm text-white/60">
            Marketplace installs stay click-first and permission-aware. Public assets are safe-by-default,
            declarative-first, and separate from legacy executable packages.
          </div>
        </ShellCard>

        <ShellCard eyebrow="Featured assets" title="Browse installable skills, workflows, and agents">
          <div className="space-y-3">
            {featuredAssets.map((asset, index) => {
              const detail = featuredDetails[index]?.data;
              const permissionExpanded = expandedPermissionAssetId === asset.assetId;

              return (
                <article
                  key={asset.assetId}
                  className="agent-subcard p-4"
                  data-highlighted={permissionExpanded ? "true" : "false"}
                  data-testid={`marketplace-asset-card-${asset.assetId}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-white">{asset.title}</h3>
                        <StatusPill tone={toneForMaturity(asset.maturity)}>
                          {asset.maturity.replaceAll("_", " ")}
                        </StatusPill>
                      </div>
                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/45">
                        {asset.assetType} · {asset.publisherName}
                      </p>
                    </div>
                    <StatusPill tone={asset.installable ? "success" : "warning"}>
                      {asset.installable ? "ready" : "review first"}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-white/65">{compactText(asset.summary)}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/50">
                    <span>Trust {asset.trustScore ?? "n/a"}</span>
                    <span>Version {asset.latestVersion ?? "n/a"}</span>
                    <span>{asset.verificationStatus}</span>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="flex flex-wrap gap-2 text-xs text-white/55">
                      {(detail?.permissions.length
                        ? detail.permissions.slice(0, permissionExpanded ? detail.permissions.length : 4)
                        : []
                      ).map((permission) => (
                        <span key={permission} className="rounded-full border border-white/10 px-2 py-1">
                          {permission}
                        </span>
                      ))}
                      {!detail?.permissions.length ? (
                        <span className="rounded-full border border-white/10 px-2 py-1 text-white/45">
                          no additional permissions
                        </span>
                      ) : null}
                    </div>
                    {detail?.permissions.length ? (
                      <button
                        type="button"
                        className="text-xs font-medium text-[var(--accent-soft)] transition hover:text-white"
                        data-testid={`marketplace-permissions-toggle-${asset.assetId}`}
                        onClick={() =>
                          setExpandedPermissionAssetId((current) =>
                            current === asset.assetId ? null : asset.assetId,
                          )
                        }
                      >
                        {permissionExpanded ? "Hide permission preview" : "Preview permissions"}
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {asset.assetType === "skill" && asset.installable ? (
                      <ActionButton
                        data-testid={`marketplace-install-${asset.assetId}`}
                        disabled={installSkillMutation.isPending}
                        onClick={() =>
                          installSkillMutation.mutate({ skillId: asset.assetId.replace(/^skill:/, "") })
                        }
                      >
                        <PackagePlus className="mr-2 size-4" />
                        Install
                      </ActionButton>
                    ) : (
                      <ActionButton tone="secondary" as-child={false} onClick={() => undefined} disabled>
                        Install from assistant
                      </ActionButton>
                    )}
                    <ActionButton
                      data-testid={`marketplace-support-${asset.assetId}`}
                      tone="secondary"
                      disabled={supportMutation.isPending}
                      onClick={() => supportMutation.mutate(asset.assetId)}
                    >
                      <Gift className="mr-2 size-4" />
                      Support creator
                    </ActionButton>
                    {asset.assetType === "skill" ? (
                      <Link
                        className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                        to={buildSkillHref(asset.assetId.replace(/^skill:/, ""), "install")}
                      >
                        Details
                      </Link>
                    ) : asset.assetType === "workflow" ? (
                      <Link
                        className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                        to="/workflows"
                      >
                        Workflow details
                      </Link>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {featuredAssets.length === 0 ? (
              <p className="text-sm text-white/60">No public declarative assets are available yet.</p>
            ) : null}
          </div>
        </ShellCard>

        <ShellCard eyebrow="Request board" title="Ask for a personal skill, workflow, or agent">
          <div className="grid gap-4 lg:grid-cols-[1fr_0.95fr]">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                createRequestMutation.mutate();
              }}
            >
              <FieldLabel label="Asset type" />
              <div className="flex flex-wrap gap-2">
                {(["skill", "workflow", "agent"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setRequestAssetKind(kind)}
                    className="inline-flex rounded-2xl border border-white/10 px-3 py-2 text-sm text-white/70 transition hover:border-white/20 hover:bg-white/[0.06]"
                    data-testid={`marketplace-request-kind-${kind}`}
                    data-active={requestAssetKind === kind}
                  >
                    {kind}
                  </button>
                ))}
              </div>
              <FieldLabel label="Title" hint="Short description of what you want built." />
              <input
                value={requestTitle}
                onChange={(event) => setRequestTitle(event.target.value)}
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none focus:border-[var(--accent-soft)]"
                placeholder="Personal workflow for weekly client updates"
                data-testid="marketplace-request-title"
              />
              <FieldLabel label="Goal" hint="What problem should this asset solve?" />
              <textarea
                value={requestGoal}
                onChange={(event) => setRequestGoal(event.target.value)}
                className="min-h-28 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none focus:border-[var(--accent-soft)]"
                placeholder="I need something that gathers updates, drafts a summary, and reminds me if data is missing."
                data-testid="marketplace-request-goal"
              />
              <FieldLabel label="Desired outcome" hint="How will you know the request is complete?" />
              <textarea
                value={requestOutcome}
                onChange={(event) => setRequestOutcome(event.target.value)}
                className="min-h-24 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none focus:border-[var(--accent-soft)]"
                placeholder="I can trigger it every Friday and it outputs a clean summary I can review."
                data-testid="marketplace-request-outcome"
              />
              <FieldLabel label="Constraints" hint="Optional. One per line." />
              <textarea
                value={requestConstraints}
                onChange={(event) => setRequestConstraints(event.target.value)}
                className="min-h-20 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none focus:border-[var(--accent-soft)]"
                placeholder="No outbound network access&#10;Must stay inside existing workspace"
                data-testid="marketplace-request-constraints"
              />
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <FieldLabel label="Support intent" hint="Optional support/tip guidance." />
                  <input
                    value={requestBudget}
                    onChange={(event) => setRequestBudget(event.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none focus:border-[var(--accent-soft)]"
                    placeholder="$50 tip if it ships cleanly"
                    data-testid="marketplace-request-budget"
                  />
                </div>
                <div>
                  <FieldLabel label="Risk notes" hint="Optional permission or boundary notes." />
                  <input
                    value={requestRiskNotes}
                    onChange={(event) => setRequestRiskNotes(event.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none focus:border-[var(--accent-soft)]"
                    placeholder="No production write access"
                    data-testid="marketplace-request-risk-notes"
                  />
                </div>
              </div>
              <ActionButton
                type="submit"
                disabled={!canSubmitRequest || createRequestMutation.isPending}
                data-testid="marketplace-request-submit"
              >
                <Wand2 className="mr-2 size-4" />
                Post request
              </ActionButton>
            </form>

            <div className="space-y-3">
              {openRequests.map((request, index) => {
                const bundle = requestBundles[index]?.data;
                const responses = bundle?.responses ?? [];

                return (
                  <article
                    key={request.id}
                    className="agent-subcard p-4"
                    data-testid={`marketplace-request-card-${request.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium text-white">{request.title}</h3>
                        <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/45">
                          {request.assetKind} · {request.status.replaceAll("_", " ")}
                        </p>
                      </div>
                      <StatusPill tone={request.status === "accepted" ? "success" : "warning"}>
                        {request.status.replaceAll("_", " ")}
                      </StatusPill>
                    </div>
                    <p className="mt-3 text-sm text-white/65">{compactText(request.goal)}</p>
                    <p className="mt-2 text-xs text-white/45">
                      Desired outcome: {compactText(request.desiredOutcome)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/45">
                      <span>{request.privacy}</span>
                      <span>{request.publishability.replaceAll("_", " ")}</span>
                      {request.budgetSupportIntent ? <span>{request.budgetSupportIntent}</span> : null}
                    </div>
                    <div className="mt-4 space-y-2">
                      <textarea
                        value={requestResponseDrafts[request.id] ?? ""}
                        onChange={(event) =>
                          setRequestResponseDrafts((current) => ({
                            ...current,
                            [request.id]: event.target.value,
                          }))
                        }
                        className="min-h-20 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none focus:border-[var(--accent-soft)]"
                        placeholder="Offer help, propose an approach, or ask a clarifying question."
                        data-testid={`marketplace-request-response-input-${request.id}`}
                      />
                      <ActionButton
                        data-testid={`marketplace-request-respond-${request.id}`}
                        tone="secondary"
                        disabled={respondMutation.isPending || !(requestResponseDrafts[request.id] ?? "").trim()}
                        onClick={() =>
                          respondMutation.mutate({
                            requestId: request.id,
                            message: (requestResponseDrafts[request.id] ?? "").trim(),
                          })
                        }
                      >
                        <Users className="mr-2 size-4" />
                        Respond
                      </ActionButton>
                      {responses.length ? (
                        <div className="space-y-2" data-testid={`marketplace-request-responses-${request.id}`}>
                          {responses.map((response) => {
                            const accepted = request.acceptedResponseId === response.id;

                            return (
                              <div
                                key={response.id}
                                className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3"
                                data-testid={`marketplace-request-response-${response.id}`}
                              >
                                <p className="text-xs uppercase tracking-[0.18em] text-white/40">
                                  {response.responderCreatorId
                                    ? `creator ${response.responderCreatorId}`
                                    : "community response"}
                                </p>
                                <p className="mt-2 text-sm text-white/70">{response.message}</p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {!accepted && request.status !== "closed" ? (
                                    <ActionButton
                                      tone="secondary"
                                      data-testid={`marketplace-request-accept-${request.id}-${response.id}`}
                                      disabled={acceptMutation.isPending}
                                      onClick={() =>
                                        acceptMutation.mutate({
                                          requestId: request.id,
                                          responseId: response.id,
                                        })
                                      }
                                    >
                                      Accept response
                                    </ActionButton>
                                  ) : null}
                                  {accepted ? <StatusPill tone="success">accepted</StatusPill> : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      {request.status !== "closed" ? (
                        <ActionButton
                          tone="secondary"
                          data-testid={`marketplace-request-close-${request.id}`}
                          disabled={closeMutation.isPending}
                          onClick={() => closeMutation.mutate(request.id)}
                        >
                          Close request
                        </ActionButton>
                      ) : null}
                    </div>
                  </article>
                );
              })}
              {openRequests.length === 0 ? (
                <p className="text-sm text-white/60">No open requests yet. Post one when the catalog does not fit.</p>
              ) : null}
            </div>
          </div>
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard eyebrow="Creator support" title="Support useful creators without platform commission">
          <div className="space-y-3">
            {creators.slice(0, 5).map((creator) => (
              <article key={creator.id} className="agent-subcard p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium text-white">{creator.displayName}</h3>
                    <p className="mt-1 text-xs text-white/45">{creator.verifiedPublisher ? "verified creator" : "community creator"}</p>
                  </div>
                  <StatusPill tone={creator.reputation.overallScore >= 70 ? "success" : "warning"}>
                    score {creator.reputation.overallScore}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-white/65">{compactText(creator.bio)}</p>
                <div className="mt-3 grid gap-2 text-xs text-white/50 sm:grid-cols-2">
                  <span>{creator.reputation.supportCount} supports</span>
                  <span>{formatMoney(creator.reputation.supportTotal)}</span>
                  <span>{creator.reputation.installCount} installs</span>
                  <span>{creator.reputation.fulfilledRequestCount} fulfilled requests</span>
                </div>
              </article>
            ))}
            {creators.length === 0 ? (
              <p className="text-sm text-white/60">Creator profiles will appear here as public assets and support events accumulate.</p>
            ) : null}
          </div>
        </ShellCard>

        <ShellCard eyebrow="Safety boundary" title="What this marketplace is and is not">
          <div className="space-y-3 text-sm text-white/65">
            <div className="agent-detail-note p-4">
              Friday’s public marketplace is declarative-first and permission-aware. Public assets are meant to be
              inspectable, installable, and supportable without exposing users to arbitrary runtime packages.
            </div>
            <ul className="space-y-2">
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 text-emerald-200" /> Public assets show permissions before enable/install.</li>
              <li className="flex gap-2"><Sparkles className="mt-0.5 size-4 text-amber-200" /> Friday does not take commission, provide guarantees, or offer after-sales support.</li>
              <li className="flex gap-2"><Gift className="mt-0.5 size-4 text-sky-200" /> Support/tips are creator-first recognition, not a service warranty.</li>
            </ul>
          </div>
        </ShellCard>
      </div>
    </div>
  );
}
