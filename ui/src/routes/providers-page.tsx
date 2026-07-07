import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, PlugZap, RefreshCw, Route, ShieldCheck, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { providersApi } from "@/lib/api/providers";
import type {
  FridayProviderCapabilityHealthSnapshotItem,
  FridayProviderCapabilityHealthState,
  FridayProviderHealthSnapshotItem,
  FridayProviderProfile,
  FridayRuntimeCapabilityId,
} from "@/lib/api/types";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

const PARITY_CAPABILITIES: FridayRuntimeCapabilityId[] = [
  "text",
  "vision",
  "file_read",
  "file_write",
  "browser",
  "skills",
];

type ProviderCapabilityMatrixCell = {
  providerId: string;
  providerName: string;
  state: FridayProviderCapabilityHealthState;
  label: string;
};

type ProviderCapabilityMatrixRow = {
  capability: FridayRuntimeCapabilityId;
  cells: ProviderCapabilityMatrixCell[];
};

function laneTone(lane?: FridayProviderHealthSnapshotItem["lane"]): "neutral" | "success" | "warning" | "danger" {
  if (lane === "primary") return "success";
  if (lane === "fallback") return "warning";
  if (lane === "disabled") return "neutral";
  return "neutral";
}

function validationTone(status?: FridayProviderHealthSnapshotItem["validationStatus"]): "neutral" | "success" | "warning" | "danger" {
  if (status === "ok") return "success";
  if (status === "failed") return "danger";
  if (status === "never") return "warning";
  return "neutral";
}

function providerSubtitle(provider: FridayProviderProfile, health?: FridayProviderHealthSnapshotItem): string {
  const model = provider.defaultModel ?? health?.defaultModel ?? provider.config.supportedModels[0] ?? "model not set";
  return `${provider.kind} / ${provider.config.authMode} / ${model}`;
}

function capabilityStateLabel(item: FridayProviderCapabilityHealthSnapshotItem | undefined): string {
  if (!item) return "registry pending";
  const available = item.capabilities.filter((capability) => capability.state === "available").length;
  const total = item.capabilities.length;
  return total > 0 ? `${available}/${total} available` : "no capability proofs";
}

function capabilityTone(state: FridayProviderCapabilityHealthState): "neutral" | "success" | "warning" | "danger" {
  if (state === "available") return "success";
  if (state === "setup_needed" || state === "proof_pending") return "warning";
  if (state === "disabled" || state === "unsupported") return "danger";
  return "neutral";
}

function capabilityLabel(state: FridayProviderCapabilityHealthState): string {
  if (state === "available") return "available";
  if (state === "setup_needed") return "setup needed";
  if (state === "proof_pending") return "proof pending";
  return state;
}

function fallbackProviderRows(): FridayProviderProfile[] {
  return [
    {
      id: "codex",
      kind: "openai-codex",
      name: "Codex",
      baseUrl: "provider://codex",
      enabled: false,
      config: {
        api: "openai-codex-responses",
        authMode: "oauth",
        keySource: { kind: "external-session" },
        supportedModels: [],
      },
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "claude",
      kind: "anthropic",
      name: "Claude",
      baseUrl: "provider://claude",
      enabled: false,
      config: {
        api: "anthropic-messages",
        authMode: "oauth",
        keySource: { kind: "external-session" },
        supportedModels: [],
      },
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "deepseek",
      kind: "deepseek",
      name: "DeepSeek",
      baseUrl: "provider://deepseek",
      enabled: false,
      config: {
        api: "openai-completions",
        authMode: "api-key",
        keySource: { kind: "env-ref", envVar: "FRIDAY_DEEPSEEK_API_KEY" },
        supportedModels: [],
      },
      createdAt: "",
      updatedAt: "",
    },
  ];
}

export function deriveProviderCapabilityMatrix(
  providers: FridayProviderProfile[],
  capabilityByProvider: Map<string, FridayProviderCapabilityHealthSnapshotItem>,
): ProviderCapabilityMatrixRow[] {
  const visibleProviders = providers.slice(0, 3);
  const capabilities = new Set<FridayRuntimeCapabilityId>();
  for (const provider of visibleProviders) {
    const snapshot = capabilityByProvider.get(provider.id);
    for (const capability of snapshot?.capabilities ?? []) {
      capabilities.add(capability.capability);
    }
  }
  const rows = Array.from(capabilities);
  return rows.map((capability) => ({
    capability,
    cells: visibleProviders.map((provider) => {
      const snapshot = capabilityByProvider.get(provider.id);
      const item = snapshot?.capabilities.find((candidate) => candidate.capability === capability);
      const state = item?.state ?? "unsupported";
      return {
        providerId: provider.id,
        providerName: provider.name,
        state,
        label: capabilityLabel(state),
      };
    }),
  }));
}

function ProviderAuthRow(props: {
  provider: FridayProviderProfile;
  health?: FridayProviderHealthSnapshotItem;
  capability?: FridayProviderCapabilityHealthSnapshotItem;
  onValidate: (providerId: string) => void;
  validating: boolean;
}) {
  const { locale } = useAppLocale();
  const { provider, health, capability, onValidate, validating } = props;
  return (
    <div className="grid gap-4 border-b border-[color:var(--color-border-soft)] py-4 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-[color:var(--color-text-primary)]">{provider.name}</p>
          <StatusPill tone={provider.enabled ? "success" : "neutral"}>
            {provider.enabled ? "enabled" : "disabled"}
          </StatusPill>
          <StatusPill tone={laneTone(health?.lane)}>{health?.lane ?? "lane unknown"}</StatusPill>
          <StatusPill tone={validationTone(health?.validationStatus)}>
            {health?.validationStatus ?? provider.config.validation?.status ?? "validation unknown"}
          </StatusPill>
        </div>
        <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">{providerSubtitle(provider, health)}</p>
        <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
          auth-ready != parity · {capabilityStateLabel(capability)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 lg:justify-end">
        <ActionButton
          tone="secondary"
          data-action="provider_auth_validate"
          data-cap="provider_auth"
          data-truth="wired_registry"
          disabled={validating}
          onClick={() => onValidate(provider.id)}
        >
          <ShieldCheck className="mr-2 h-4 w-4" />
          {validating ? localize(locale, "验证中", "Validating") : localize(locale, "Validate", "Validate")}
        </ActionButton>
        <ActionButton
          tone="secondary"
          data-action="provider_oauth_reauth"
          data-cap="provider_auth"
          data-truth="operator_gated"
          disabled
        >
          <KeyRound className="mr-2 h-4 w-4" />
          {provider.config.authMode === "oauth" ? "OAuth" : "Secret"}
        </ActionButton>
      </div>
    </div>
  );
}

function TruthChip(props: {
  cap: string;
  truth: "NO-GO" | "external_blocked" | "wired_registry" | "operator_gated";
  children: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  disabled?: boolean;
}) {
  return (
    <span
      role={props.disabled ? "button" : undefined}
      aria-disabled={props.disabled ? true : undefined}
      data-cap={props.cap}
      data-truth={props.truth}
      className="inline-flex min-h-[30px] items-center rounded-[var(--radius-sm)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-secondary)] data-[truth=NO-GO]:border-[color:var(--color-border-danger)] data-[truth=NO-GO]:text-[color:var(--color-text-danger)] data-[truth=external_blocked]:border-[color:var(--color-border-warning)] data-[truth=external_blocked]:text-[color:var(--color-text-warning)]"
    >
      <StatusPill tone={props.tone ?? (props.truth === "wired_registry" ? "success" : props.truth === "operator_gated" ? "warning" : "danger")}>{props.children}</StatusPill>
    </span>
  );
}

function CapabilityMatrix(props: {
  providers: FridayProviderProfile[];
  capabilityByProvider: Map<string, FridayProviderCapabilityHealthSnapshotItem>;
}) {
  const visibleProviders = props.providers.slice(0, 3);
  const providers = visibleProviders.length > 0 ? visibleProviders : fallbackProviderRows();
  const rows = visibleProviders.length > 0
    ? deriveProviderCapabilityMatrix(visibleProviders, props.capabilityByProvider)
    : PARITY_CAPABILITIES.map((capability) => ({
        capability,
        cells: providers.map((provider) => ({
          providerId: provider.id,
          providerName: provider.name,
          state: "unsupported" as const,
          label: "NO-GO",
        })),
      }));

  return (
    <div
      data-ui-component="capabilityMatrixAndQueues"
      className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border-soft)]"
    >
      <div className="grid min-w-[620px] grid-cols-[180px_repeat(3,minmax(120px,1fr))] bg-[color:var(--color-bg-subtle)] text-xs font-semibold text-[color:var(--color-text-secondary)]">
        <div className="border-r border-[color:var(--color-border-soft)] p-3">Capability</div>
        {providers.map((provider) => (
          <div key={provider.id} className="border-r border-[color:var(--color-border-soft)] p-3 last:border-r-0">
            {provider.name}
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <div
          key={row.capability}
          className="grid min-w-[620px] grid-cols-[180px_repeat(3,minmax(120px,1fr))] border-t border-[color:var(--color-border-soft)] text-xs"
        >
          <div className="border-r border-[color:var(--color-border-soft)] p-3 font-medium text-[color:var(--color-text-primary)]">{row.capability}</div>
          {row.cells.map((cell) => (
            <div key={`${cell.providerId}:${row.capability}`} className="border-r border-[color:var(--color-border-soft)] p-3 last:border-r-0">
              {cell.state === "available" ? (
                <TruthChip cap={`provider_capability:${row.capability}`} truth="wired_registry" tone="success">available</TruthChip>
              ) : (
                <TruthChip cap={`provider_capability:${row.capability}`} truth="NO-GO" tone={capabilityTone(cell.state)} disabled>
                  {cell.label === "unsupported" ? "NO-GO" : cell.label}
                </TruthChip>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ProvidersPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ["providers-surface", "providers"],
    queryFn: () => providersApi.list(),
  });
  const healthQuery = useQuery({
    queryKey: ["providers-surface", "health"],
    queryFn: () => providersApi.listHealth(),
  });
  const capabilityHealthQuery = useQuery({
    queryKey: ["providers-surface", "capability-health"],
    queryFn: () => providersApi.listCapabilityHealth(),
  });
  const routingQuery = useQuery({
    queryKey: ["providers-surface", "routing"],
    queryFn: () => providersApi.getRouting(),
  });
  const validateMutation = useMutation({
    mutationFn: (providerId: string) => providersApi.validate(providerId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["providers-surface", "providers"] }),
        queryClient.invalidateQueries({ queryKey: ["providers-surface", "health"] }),
        queryClient.invalidateQueries({ queryKey: ["providers-surface", "capability-health"] }),
      ]);
      toast.success(localize(locale, "Provider validation refreshed", "Provider validation refreshed"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Provider validation failed");
    },
  });
  const doctorMutation = useMutation({
    mutationFn: () => providersApi.runCapabilityDoctor(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["providers-surface", "providers"] }),
        queryClient.invalidateQueries({ queryKey: ["providers-surface", "health"] }),
        queryClient.invalidateQueries({ queryKey: ["providers-surface", "capability-health"] }),
      ]);
      toast.success(localize(locale, "Capability doctor complete", "Capability doctor complete"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Capability doctor failed");
    },
  });

  const providers = providersQuery.data ?? [];
  const healthByProvider = useMemo(() => new Map((healthQuery.data ?? []).map((item) => [item.providerId, item])), [healthQuery.data]);
  const capabilityByProvider = useMemo(() => new Map((capabilityHealthQuery.data ?? []).map((item) => [item.providerId, item])), [capabilityHealthQuery.data]);
  const defaultProvider = providers.find((provider) => provider.id === routingQuery.data?.defaultProviderId);
  const queuedProviders = providers.filter((provider) => provider.enabled).slice(0, 4);

  return (
    <div data-ui-screen="desktop-providers" className="space-y-5 pb-6">
      <section className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              Providers & auth
            </p>
            <h2 className="mt-1 text-3xl font-semibold tracking-tight text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
              {localize(locale, "提供方认证、parity 与队列真相", "Provider auth, parity, and queue truth")}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[color:var(--color-text-secondary)]">
              auth-ready != parity · capabilityMatrixAndQueues · provider_adapter_parity NO-GO · routing external_blocked
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <ActionButton
              tone="secondary"
              data-action="providers_detect"
              data-cap="providers_detect"
              data-truth="wired_registry"
              onClick={() => {
                void providersQuery.refetch();
                void healthQuery.refetch();
                void capabilityHealthQuery.refetch();
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Detect providers
            </ActionButton>
            <ActionButton
              data-action="run_smoke"
              data-cap="provider_smoke"
              data-truth="wired_registry"
              disabled={doctorMutation.isPending}
              onClick={() => doctorMutation.mutate()}
            >
              <PlugZap className="mr-2 h-4 w-4" />
              {doctorMutation.isPending ? localize(locale, "Running", "Running") : "Run smoke"}
            </ActionButton>
          </div>
        </div>
      </section>

      <ShellCard
        eyebrow={localize(locale, "Provider auth", "Provider auth")}
        title={localize(locale, "Readiness lanes", "Readiness lanes")}
        aside={<StatusPill tone={providers.length > 0 ? "success" : "warning"}>{providers.length} providers</StatusPill>}
      >
        {providers.length === 0 ? (
          <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "尚未配置任何提供方。", "No providers configured yet.")}</p>
        ) : (
          <div>
            {providers.map((provider) => (
              <ProviderAuthRow
                key={provider.id}
                provider={provider}
                health={healthByProvider.get(provider.id)}
                capability={capabilityByProvider.get(provider.id)}
                validating={validateMutation.isPending && validateMutation.variables === provider.id}
                onValidate={(providerId) => validateMutation.mutate(providerId)}
              />
            ))}
          </div>
        )}
      </ShellCard>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]">
        <ShellCard
          eyebrow={localize(locale, "Parity view", "Parity view")}
          title="capabilityMatrixAndQueues"
          aside={<StatusPill tone="danger">provider_adapter_parity · NO-GO</StatusPill>}
        >
          <CapabilityMatrix providers={providers} capabilityByProvider={capabilityByProvider} />
          <p className="mt-3 text-xs leading-5 text-[color:var(--color-text-secondary)]">
            Cells are registry-derived truth chips. Auth readiness never upgrades provider_adapter_parity into runtime parity.
          </p>
        </ShellCard>

        <div className="space-y-5">
          <ShellCard
            eyebrow={localize(locale, "Queues", "Queues")}
            title={localize(locale, "Hub projection", "Hub projection")}
            aside={<StatusPill tone="neutral">read-only</StatusPill>}
          >
            <div className="space-y-3">
              {(queuedProviders.length ? queuedProviders : providers.slice(0, 1)).map((provider) => (
                <div key={provider.id} className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border-soft)] pb-3 last:border-b-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{provider.name}</p>
                    <p className="text-xs text-[color:var(--color-text-secondary)]">{healthByProvider.get(provider.id)?.suggestedAction ?? "queue projection pending"}</p>
                  </div>
                  <StatusPill tone={laneTone(healthByProvider.get(provider.id)?.lane)}>{healthByProvider.get(provider.id)?.lane ?? "pending"}</StatusPill>
                </div>
              ))}
              {providers.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-secondary)]">No queue projection until a provider exists.</p>
              ) : null}
            </div>
          </ShellCard>

          <ShellCard
            eyebrow={localize(locale, "Multi-provider routing", "Multi-provider routing")}
            title={defaultProvider?.name ?? "Routing pending"}
            aside={<StatusPill tone="danger">external_blocked</StatusPill>}
          >
            <div className="flex items-start gap-3">
              <Route className="mt-1 h-4 w-4 text-[color:var(--color-text-faint)]" />
              <div>
                <p className="text-sm text-[color:var(--color-text-primary)]">
                  {defaultProvider ? `${defaultProvider.name} / ${routingQuery.data?.defaultModel ?? defaultProvider.defaultModel ?? "model not set"}` : "Default route not configured"}
                </p>
                <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                  Route across providers is external_blocked until provider parity and environment availability are proven.
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <ActionButton
                tone="secondary"
                data-action="multi_provider_routing"
                data-cap="multi_provider_routing"
                data-truth="external_blocked"
                disabled
              >
                <Waypoints className="mr-2 h-4 w-4" />
                Routing
              </ActionButton>
            </div>
          </ShellCard>

          <ShellCard
            eyebrow={localize(locale, "Explicit NO-GO", "Explicit NO-GO")}
            title={localize(locale, "Session control and parity blockers", "Session control and parity blockers")}
            aside={<StatusPill tone="danger">shown disabled</StatusPill>}
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">Session control</p>
                  <p className="text-xs text-[color:var(--color-text-secondary)]">start / pause / resume / stop remain provider_adapter_parity NO-GO until runtime parity is proven.</p>
                </div>
                <TruthChip cap="session_control_native_set" truth="NO-GO" disabled>Controls</TruthChip>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">Approvals</p>
                  <p className="text-xs text-[color:var(--color-text-secondary)]">Only approval gate truth is wired through the registry in this surface.</p>
                </div>
                <TruthChip cap="security_approval_bound_principal_gate" truth="wired_registry" tone="success">wired</TruthChip>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">provider_native_synced</p>
                  <p className="text-xs text-[color:var(--color-text-secondary)]">Native session mirroring is visible and disabled, never hidden.</p>
                </div>
                <TruthChip cap="provider_native_synced" truth="NO-GO" disabled>Enable</TruthChip>
              </div>
            </div>
          </ShellCard>
        </div>
      </div>
    </div>
  );
}
