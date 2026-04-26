import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import {
  discoveryApi,
  type DiscoveredProgram,
  type IntegrationRecommendation,
  type ProgramCategory,
} from "@/lib/api/discovery";
import { ShellCard, StatusPill, ActionButton, SkeletonLine } from "@/components/core/primitives";

// ─── Helpers ───

const CATEGORY_LABELS: Record<ProgramCategory, [zh: string, en: string]> = {
  browser: ["浏览器", "Browser"],
  editor: ["编辑器", "Editor"],
  terminal: ["终端", "Terminal"],
  communication: ["通讯", "Communication"],
  media: ["媒体", "Media"],
  productivity: ["生产力", "Productivity"],
  development: ["开发", "Development"],
  database: ["数据库", "Database"],
  cloud: ["云服务", "Cloud"],
  security: ["安全", "Security"],
  automation: ["自动化", "Automation"],
  design: ["设计", "Design"],
  finance: ["财务", "Finance"],
  system: ["系统", "System"],
  other: ["其他", "Other"],
};

const PATH_LABELS: Record<IntegrationRecommendation["integrationPath"], [zh: string, en: string]> = {
  "code-repo": ["代码仓库", "Code Repo"],
  "rest-api": ["REST API", "REST API"],
  "web-flow": ["Web 流程", "Web Flow"],
  "desktop-recording": ["桌面录制", "Desktop Recording"],
  "desktop-control": ["桌面控制", "Desktop Control"],
};

function toneForCategory(_cat: ProgramCategory): "neutral" | "success" | "warning" {
  return "neutral";
}

function groupByCategory(programs: DiscoveredProgram[]): Map<ProgramCategory, DiscoveredProgram[]> {
  const map = new Map<ProgramCategory, DiscoveredProgram[]>();
  for (const p of programs) {
    const list = map.get(p.category) ?? [];
    list.push(p);
    map.set(p.category, list);
  }
  return map;
}

// ─── Sub-components ───

function ProgramCard({ program, locale }: { program: DiscoveredProgram; locale: "en" | "zh" }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[color:var(--color-text-primary)]">
          {program.name}
          {program.version && (
            <span className="ml-1.5 text-xs text-[color:var(--color-text-tertiary)]">v{program.version}</span>
          )}
        </p>
      </div>
      <StatusPill tone={toneForCategory(program.category)}>
        {localize(locale, ...CATEGORY_LABELS[program.category])}
      </StatusPill>
      {program.isCli && (
        <StatusPill tone="warning">CLI</StatusPill>
      )}
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[color:var(--color-bg-subtle)]">
        <div
          className="h-full rounded-full bg-[color:var(--color-accent)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-[color:var(--color-text-tertiary)]">{pct}%</span>
    </div>
  );
}

function RecommendationRow({
  rec,
  locale,
}: {
  rec: IntegrationRecommendation;
  locale: "en" | "zh";
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{rec.programName}</p>
        <p className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">{rec.rationale}</p>
      </div>
      <StatusPill>{localize(locale, ...PATH_LABELS[rec.integrationPath])}</StatusPill>
      <ConfidenceBar value={rec.confidence} />
      <ActionButton tone="secondary" className="shrink-0 text-xs">
        {localize(locale, "一键集成", "Integrate")}
      </ActionButton>
    </div>
  );
}

// ─── Main panel ───

export function DiscoveryPanel() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["discovery", "status"],
    queryFn: () => discoveryApi.getStatus(),
    staleTime: 60_000,
  });

  const scanMutation = useMutation({
    mutationFn: () => discoveryApi.scan(),
    onSuccess: (result) => {
      toast.success(
        localize(
          locale,
          `扫描完成 — 发现 ${result.catalog.programCount} 个程序`,
          `Scan complete — found ${result.catalog.programCount} programs`,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ["discovery"] });
    },
    onError: () => {
      toast.error(localize(locale, "扫描失败，请稍后再试", "Scan failed, please try again"));
    },
  });

  const hasCatalog = statusQuery.data?.hasCatalog ?? false;

  const programsQuery = useQuery({
    queryKey: ["discovery", "programs"],
    queryFn: () => discoveryApi.getPrograms(),
    staleTime: 60_000,
    enabled: hasCatalog,
  });

  const recsQuery = useQuery({
    queryKey: ["discovery", "recommendations"],
    queryFn: () => discoveryApi.getRecommendations(),
    staleTime: 60_000,
    enabled: hasCatalog,
  });

  // ── Error fallback ──
  if (statusQuery.isError) {
    return (
      <ShellCard
        eyebrow={localize(locale, "程序发现", "Program Discovery")}
        title={localize(locale, "发现功能不可用", "Discovery Unavailable")}
      >
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "无法获取发现功能状态。请确认后端已启用该功能。",
            "Unable to fetch discovery status. Ensure the backend has this feature enabled.",
          )}
        </p>
      </ShellCard>
    );
  }

  // ── Loading skeleton ──
  if (statusQuery.isLoading) {
    return (
      <ShellCard
        eyebrow={localize(locale, "程序发现", "Program Discovery")}
        title={localize(locale, "本机程序", "Local Programs")}
      >
        <div className="space-y-3">
          <SkeletonLine width="60%" />
          <SkeletonLine width="80%" />
          <SkeletonLine width="45%" />
        </div>
      </ShellCard>
    );
  }

  const programs = programsQuery.data?.programs ?? [];
  const grouped = groupByCategory(programs);
  const recommendations = recsQuery.data?.recommendations ?? [];
  const discoveryDisabled = statusQuery.data && !statusQuery.data.enabled;

  if (discoveryDisabled) {
    return (
      <ShellCard
        eyebrow={localize(locale, "程序发现", "Program Discovery")}
        title={localize(locale, "发现功能未启用", "Discovery Disabled")}
      >
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          {statusQuery.data.unavailableReason
            ?? localize(
              locale,
              "本机程序发现当前未启用。启用后可扫描本机程序并生成集成建议。",
              "Local program discovery is currently disabled. Enable it to scan local programs and generate integration suggestions.",
            )}
        </p>
      </ShellCard>
    );
  }

  return (
    <div className="space-y-4">
      <ShellCard
        eyebrow={localize(locale, "程序发现", "Program Discovery")}
        title={localize(locale, "本机程序", "Local Programs")}
        aside={
          <ActionButton
            tone="primary"
            disabled={scanMutation.isPending}
            onClick={() => scanMutation.mutate()}
          >
            {scanMutation.isPending
              ? localize(locale, "扫描中…", "Scanning...")
              : localize(locale, "扫描本机程序", "Scan Local Programs")}
          </ActionButton>
        }
      >
        {statusQuery.data && (
          <p className="mb-4 text-xs text-[color:var(--color-text-tertiary)]">
            {localize(
              locale,
              `已发现 ${statusQuery.data.programCount} 个程序`,
              `${statusQuery.data.programCount} programs discovered`,
            )}
            {statusQuery.data.lastScanAt && (
              <>
                {" — "}
                {localize(locale, "上次扫描 ", "Last scan ")}{new Date(statusQuery.data.lastScanAt).toLocaleString()}
              </>
            )}
          </p>
        )}

        {hasCatalog && programsQuery.isLoading && (
          <div className="space-y-3">
            <SkeletonLine width="60%" />
            <SkeletonLine width="80%" />
            <SkeletonLine width="45%" />
          </div>
        )}

        {hasCatalog && programs.length > 0 && (
          <div className="space-y-5">
            {Array.from(grouped.entries()).map(([category, items]) => (
              <div key={category}>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-secondary)]">
                  {localize(locale, ...CATEGORY_LABELS[category])}
                </h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((p) => (
                    <ProgramCard key={p.id} program={p} locale={locale} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {hasCatalog && !programsQuery.isLoading && programs.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "目录为空 — 点击扫描开始发现程序", "Catalog is empty — click scan to discover programs")}
          </p>
        )}

        {!hasCatalog && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "尚未扫描。点击上方按钮扫描本机已安装的程序。", "No scan yet. Click the button above to scan locally installed programs.")}
          </p>
        )}
      </ShellCard>

      {hasCatalog && recommendations.length > 0 && (
        <ShellCard
          eyebrow={localize(locale, "集成建议", "Integration Recommendations")}
          title={localize(locale, "推荐集成路径", "Recommended Integration Paths")}
        >
          <div className="space-y-2">
            {recommendations.map((rec) => (
              <RecommendationRow key={rec.programId} rec={rec} locale={locale} />
            ))}
          </div>
          {(recsQuery.data?.unmatched ?? 0) > 0 && (
            <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
              {localize(
                locale,
                `另有 ${recsQuery.data?.unmatched} 个程序暂无匹配的集成路径`,
                `${recsQuery.data?.unmatched} additional programs have no matched integration path`,
              )}
            </p>
          )}
        </ShellCard>
      )}
    </div>
  );
}
