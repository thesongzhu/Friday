import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ActionButton, ShellCard } from "@/components/core/primitives";
import { CustomPackBuilder } from "@/components/core/custom-pack-builder";
import { PackCard } from "@/components/packs/pack-card";
import { PackQuickSheet } from "@/components/packs/pack-quick-sheet";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useUserProfile } from "@/hooks/use-user-profile";
import { localize } from "@/lib/i18n/localized-text";
import { buildPackAssistantHref, buildPackChatHref, buildPackFlowHref } from "@/lib/packs/pack-links";
import { getPackById, listPacksByKind, loadCustomPackInputs, deleteCustomPack } from "@/lib/packs/pack-registry";
import { buildSkillHref } from "@/lib/skills/view-models";
import { useAppLocale } from "@/providers/locale-provider";

export function PacksPage() {
  const navigate = useAppNavigate();
  const { locale } = useAppLocale();
  const { profileType } = useUserProfile();
  const { pinnedPackIds, pinPack, unpinPack } = useHomeSurfacePreferences(profileType);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [pendingPackPath, setPendingPackPath] = useState<string | null>(null);
  const [renderTaskSection, setRenderTaskSection] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [customPackVersion, setCustomPackVersion] = useState(0);

  const industries = useMemo(() => listPacksByKind("industry"), [customPackVersion]);
  const tasks = useMemo(() => listPacksByKind("task"), [customPackVersion]);
  const customPackInputs = useMemo(() => loadCustomPackInputs(), [customPackVersion]);

  const handleCustomPackSaved = useCallback(() => {
    setCustomPackVersion((v) => v + 1);
  }, []);

  const handleDeleteCustomPack = useCallback((index: number) => {
    if (!window.confirm(localize(locale, "确定删除这个自定义包吗？", "Are you sure you want to delete this custom pack?"))) return;
    deleteCustomPack(index);
    setCustomPackVersion((v) => v + 1);
  }, [locale]);
  const selectedPack = selectedPackId ? getPackById(selectedPackId) ?? null : null;

  useEffect(() => {
    if (typeof window === "undefined") {
      setRenderTaskSection(true);
      return;
    }
    const browserWindow = window as Window & typeof globalThis & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof browserWindow.requestIdleCallback === "function") {
      const idleId = browserWindow.requestIdleCallback(() => setRenderTaskSection(true), { timeout: 180 });
      return () => browserWindow.cancelIdleCallback?.(idleId);
    }
    const timeoutId = browserWindow.setTimeout(() => setRenderTaskSection(true), 120);
    return () => browserWindow.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!pendingPackPath) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      navigate(pendingPackPath);
      setPendingPackPath(null);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [navigate, pendingPackPath]);

  return (
    <div className="space-y-5 pb-4">
      <section
        data-testid="packs-surface-ready"
        className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]"
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
          {localize(locale, "行业与任务库", "Industry & Tasks")}
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
          {localize(locale, "把常用入口加入首页，不用每次重新找", "Pin the entries you want on home")}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "Friday 自带的行业包和任务入口都保留在这里。你可以加入首页、拿下首页，或者直接从这里开始。",
            "Built-in industry packs and task entries always live here. Pin them to home, remove them from home, or launch directly.",
          )}
        </p>
      </section>

      <ShellCard title={localize(locale, "行业包", "Industries")}>
        <div className="grid gap-4 md:grid-cols-2">
          {industries.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              pinned={pinnedPackIds.includes(pack.id)}
              note={pinnedPackIds.includes(pack.id)
                ? localize(locale, "这个入口已经固定在首页。", "This pack is already pinned to home.")
                : pack.productCopy
                  ? localize(locale, pack.productCopy.resultSummary.zh, pack.productCopy.resultSummary.en)
                  : localize(locale, "可以直接加入首页，或者先打开动作。", "You can pin this pack to home or open its actions first.")}
              onOpen={() => setSelectedPackId(pack.id)}
              onPin={!pinnedPackIds.includes(pack.id) ? () => pinPack(pack.id) : undefined}
              onUnpin={pinnedPackIds.includes(pack.id) ? () => unpinPack(pack.id) : undefined}
            />
          ))}
        </div>
      </ShellCard>

      <ShellCard title={localize(locale, "自定义包", "Custom Packs")}>
        <div className="grid gap-4 md:grid-cols-2">
          {customPackInputs.map((input, index) => {
            const packId = `custom-${index}-${input.name.replace(/\s+/g, "-").toLowerCase()}`;
            const pack = getPackById(packId);
            return pack ? (
              <div key={packId} className="relative">
                <PackCard
                  pack={pack}
                  pinned={pinnedPackIds.includes(packId)}
                  note={localize(locale, input.description, input.descriptionEn || input.description)}
                  onOpen={() => setSelectedPackId(packId)}
                  onPin={!pinnedPackIds.includes(packId) ? () => pinPack(packId) : undefined}
                  onUnpin={pinnedPackIds.includes(packId) ? () => unpinPack(packId) : undefined}
                />
                <button
                  type="button"
                  onClick={() => handleDeleteCustomPack(index)}
                  className="absolute right-3 top-3 rounded-lg p-1.5 text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--color-bg-hover)] hover:text-[color:var(--color-danger)]"
                  title={localize(locale, "删除", "Delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ) : null;
          })}

          {/* Create button card */}
          <button
            type="button"
            onClick={() => setShowBuilder(true)}
            className="flex min-h-[100px] items-center justify-center rounded-2xl border-2 border-dashed border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-6 text-sm font-medium text-[color:var(--color-text-secondary)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)]"
          >
            <Plus className="mr-2 h-4 w-4" />
            {localize(locale, "创建自定义包", "Create Custom Pack")}
          </button>
        </div>
      </ShellCard>

      {renderTaskSection ? (
        <ShellCard title={localize(locale, "任务入口", "Tasks")}>
          <div className="grid gap-4 md:grid-cols-2">
            {tasks.map((pack) => (
              <PackCard
                key={pack.id}
                pack={pack}
                pinned={pinnedPackIds.includes(pack.id)}
                compact
                onOpen={() => setSelectedPackId(pack.id)}
                onPin={!pinnedPackIds.includes(pack.id) ? () => pinPack(pack.id) : undefined}
                onUnpin={pinnedPackIds.includes(pack.id) ? () => unpinPack(pack.id) : undefined}
              />
            ))}
          </div>
        </ShellCard>
      ) : (
        <ShellCard title={localize(locale, "任务入口", "Tasks")}>
          <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "正在加载更多入口。", "Loading more entries.")}
          </div>
        </ShellCard>
      )}

      <CustomPackBuilder
        open={showBuilder}
        onClose={() => setShowBuilder(false)}
        onSaved={handleCustomPackSaved}
      />

      <PackQuickSheet
        open={Boolean(selectedPack)}
        pack={selectedPack}
        onClose={() => setSelectedPackId(null)}
        onStartNow={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackFlowHref(selectedPack));
          }
        }}
        onAdjustBeforeStart={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackFlowHref(selectedPack, { mode: "adjust" }));
          }
        }}
        onOpenSkill={(skillId) => {
          setSelectedPackId(null);
          setPendingPackPath(buildSkillHref(skillId));
        }}
        onAskFriday={(prompt) => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackChatHref(selectedPack.id, prompt));
          }
        }}
        onOpenAssistant={selectedPack ? () => {
          setSelectedPackId(null);
          setPendingPackPath(buildPackAssistantHref(selectedPack.id));
        } : undefined}
        onRemoveFromHome={selectedPack && pinnedPackIds.includes(selectedPack.id) ? () => {
          unpinPack(selectedPack.id);
          setSelectedPackId(null);
        } : undefined}
      />
    </div>
  );
}
