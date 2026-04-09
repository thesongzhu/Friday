import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ActionButton, FieldLabel, ShellCard, StatusPill } from "@/components/core/primitives";
import { CrossBorderActionBoard } from "@/components/packs/cross-border-action-board";
import { useCrossBorderWorkflowPresets } from "@/hooks/use-cross-border-workflow-presets";
import { crossBorderPackApi, type CrossBorderImportInput, type CrossBorderProfileInput } from "@/lib/api/cross-border-pack";
import { localize } from "@/lib/i18n/localized-text";
import { buildPackAssistantHref, buildPackChatHref } from "@/lib/packs/pack-links";
import {
  buildCrossBorderAssistantNavigationSnapshot,
  buildCrossBorderAssistantNavigationState,
  persistCrossBorderAssistantNavigationSnapshot,
} from "@/lib/packs/cross-border-snapshot";
import { getPackById } from "@/lib/packs/pack-registry";
import { useAppLocale } from "@/providers/locale-provider";
import type { FridayCrossBorderCompetitorTarget, FridayCrossBorderWatchTarget } from "../../../src/packs/cross-border/friday-cross-border-pack.types";

const CROSS_BORDER_PACK_ID = "industry-cross-border-ecommerce";

type SetupState = CrossBorderProfileInput & {
  watchTargetsText: string;
  competitorTargetsText: string;
};

function buildEmptyState(): SetupState {
  return {
    regionFocus: "sea_tiktok",
    storeStage: "new_store",
    categoryL1: "",
    categoryL2: "",
    fulfillmentMode: "platform_fulfilled",
    priceBand: "",
    adUsage: "light",
    customerServiceMode: "solo_inbox",
    monitoringDepth: "standard",
    watchTargets: [],
    competitorTargets: [],
    watchTargetsText: "",
    competitorTargetsText: "",
  };
}

function parseWatchTargets(text: string, regionFocus: SetupState["regionFocus"]): FridayCrossBorderWatchTarget[] {
  return text
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8)
    .map((label, index) => ({
      id: `watch-${String(index + 1)}`,
      type: label.includes("店") || label.includes("seller") ? "seller" : label.includes("SKU") || label.includes("商品") ? "product" : "keyword",
      label,
      platform: regionFocus === "sea_tiktok" ? "tiktok_shop" : "amazon",
    }));
}

function parseCompetitors(text: string, regionFocus: SetupState["regionFocus"]): FridayCrossBorderCompetitorTarget[] {
  return text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8)
    .map((line, index) => {
      const [sellerName, productName] = line.split("|").map((item) => item.trim());
      return {
        id: `competitor-${String(index + 1)}`,
        sellerName,
        platform: regionFocus === "sea_tiktok" ? "tiktok_shop" : "amazon",
        ...(productName ? { productName } : {}),
      };
  });
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

export function CrossBorderPackSetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { locale } = useAppLocale();
  const [searchParams] = useSearchParams();
  const [formState, setFormState] = useState<SetupState>(() => buildEmptyState());
  const [importPayload, setImportPayload] = useState<CrossBorderImportInput>({
    kind: "store_report",
    source: "paste",
    title: "",
    rawText: "",
    publicLinks: [],
    fileNames: [],
  });
  const [publicLinksText, setPublicLinksText] = useState("");
  const {
    applyDefaultWorkflows,
    setWorkflowEnabled,
    isApplyingDefaultWorkflows,
    togglingWorkflowId,
  } = useCrossBorderWorkflowPresets();

  const pack = getPackById(CROSS_BORDER_PACK_ID);
  const profileQuery = useQuery({
    queryKey: ["cross-border-pack", "profile"],
    queryFn: () => crossBorderPackApi.getProfile(),
  });
  const snapshotQuery = useQuery({
    queryKey: ["cross-border-pack", "snapshot"],
    queryFn: () => crossBorderPackApi.getSnapshot(),
  });

  const openAssistant = async () => {
    const latestSnapshot = await queryClient.fetchQuery({
      queryKey: ["cross-border-pack", "snapshot"],
      queryFn: () => crossBorderPackApi.getSnapshot(),
    });
    const navigationSnapshot = buildCrossBorderAssistantNavigationSnapshot(snapshotQuery.data, latestSnapshot);
    if (navigationSnapshot) {
      queryClient.setQueryData(["cross-border-pack", "snapshot"], navigationSnapshot);
    }
    persistCrossBorderAssistantNavigationSnapshot(navigationSnapshot);
    navigate(buildPackAssistantHref(CROSS_BORDER_PACK_ID), {
      state: buildCrossBorderAssistantNavigationState(navigationSnapshot),
    });
  };

  useEffect(() => {
    if (!profileQuery.data) {
      return;
    }
    setFormState({
      regionFocus: profileQuery.data.regionFocus,
      storeStage: profileQuery.data.storeStage,
      categoryL1: profileQuery.data.categoryL1,
      categoryL2: profileQuery.data.categoryL2,
      fulfillmentMode: profileQuery.data.fulfillmentMode,
      priceBand: profileQuery.data.priceBand,
      adUsage: profileQuery.data.adUsage,
      customerServiceMode: profileQuery.data.customerServiceMode,
      monitoringDepth: profileQuery.data.monitoringDepth,
      watchTargets: profileQuery.data.watchTargets,
      competitorTargets: profileQuery.data.competitorTargets,
      watchTargetsText: profileQuery.data.watchTargets.map((target) => target.label).join("\n"),
      competitorTargetsText: profileQuery.data.competitorTargets
        .map((target) => `${target.sellerName}${target.productName ? ` | ${target.productName}` : ""}`)
        .join("\n"),
    });
  }, [profileQuery.data]);

  const operatingMode = useMemo(
    () => (formState.regionFocus === "sea_tiktok"
      ? localize(locale, "东南亚 / TikTok Shop", "SEA / TikTok Shop")
      : localize(locale, "北美 / Amazon", "North America / Amazon")),
    [formState.regionFocus, locale],
  );

  const saveProfile = useMutation({
    mutationFn: async () => {
      const payload: CrossBorderProfileInput = {
        ...formState,
        watchTargets: parseWatchTargets(formState.watchTargetsText, formState.regionFocus),
        competitorTargets: parseCompetitors(formState.competitorTargetsText, formState.regionFocus),
      };
      return crossBorderPackApi.saveProfile(payload);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cross-border-pack"] }),
        queryClient.invalidateQueries({ queryKey: ["home", "snapshot", "task-first"] }),
      ]);
      toast.success(localize(locale, "跨境经营设置已保存。", "Cross-border operating profile saved."));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "保存失败", "Failed to save profile"));
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const payload: CrossBorderImportInput = {
        ...importPayload,
        publicLinks: publicLinksText
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      };
      return crossBorderPackApi.importData(payload);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cross-border-pack"] }),
        queryClient.invalidateQueries({ queryKey: ["home", "snapshot", "task-first"] }),
      ]);
      setImportPayload({
        kind: "store_report",
        source: "paste",
        title: "",
        rawText: "",
        publicLinks: [],
        fileNames: [],
      });
      setPublicLinksText("");
      toast.success(localize(locale, "导入已加入跨境经营板。", "Import added to the cross-border board."));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "导入失败", "Import failed"));
    },
  });

  async function handleFileSelection(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    const fileList = Array.from(files);
    const firstFile = fileList[0];
    const nextSource = firstFile.type.startsWith("image/") ? "image_upload" : firstFile.name.endsWith(".csv") ? "csv_upload" : "paste";
    const nextNames = fileList.map((file) => file.name);
    let nextRawText = importPayload.rawText ?? "";
    if (nextSource === "csv_upload" || firstFile.type.startsWith("text/") || firstFile.name.endsWith(".txt")) {
      nextRawText = await readFileAsText(firstFile);
    }
    setImportPayload((current) => ({
      ...current,
      source: nextSource,
      rawText: nextRawText,
      fileNames: nextNames,
      title: current.title || firstFile.name,
    }));
  }

  return (
    <div className="space-y-5 pb-4" data-testid="cross-border-setup-page">
      <section className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {localize(locale, "跨境经营引导包", "Cross-border Operating Pack")}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
              {localize(locale, "先建立经营画像，再让 Friday 长出稳定流程", "Build the operating profile first, then let Friday grow a stable workflow")}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "这不是泛跨境工具页。先告诉 Friday 你做的是东南亚 TikTok Shop 还是北美 Amazon、盯什么类目、怎么履约、怎么投放和怎么做客服，然后它才会给你默认日常/每周流程。",
                "This is not a generic ecommerce settings page. Tell Friday whether you operate SEA TikTok Shop or North America Amazon, which category you watch, how you fulfill, advertise, and handle support, and it will grow the default daily and weekly operating routines.",
              )}
            </p>
          </div>
          <StatusPill tone="success">{operatingMode}</StatusPill>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
        <ShellCard title={localize(locale, "经营画像设置", "Operating profile setup")}>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "地域模式", "Operating mode")} hint={localize(locale, "第一版固定为东南亚 TikTok Shop 或北美 Amazon。", "The first version is fixed to SEA TikTok Shop or North America Amazon.")} />
                <select
                  data-testid="cross-border-region-focus"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.regionFocus}
                  onChange={(event) => setFormState((current) => ({ ...current, regionFocus: event.target.value as SetupState["regionFocus"] }))}
                >
                  <option value="sea_tiktok">{localize(locale, "东南亚 / TikTok Shop", "SEA / TikTok Shop")}</option>
                  <option value="na_amazon">{localize(locale, "北美 / Amazon", "North America / Amazon")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "店铺阶段", "Store stage")} />
                <select
                  data-testid="cross-border-store-stage"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.storeStage}
                  onChange={(event) => setFormState((current) => ({ ...current, storeStage: event.target.value as SetupState["storeStage"] }))}
                >
                  <option value="new_store">{localize(locale, "新店", "New Store")}</option>
                  <option value="scaling">{localize(locale, "增长中", "Scaling")}</option>
                  <option value="mature">{localize(locale, "成熟店铺", "Mature")}</option>
                </select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "类目 L1", "Category L1")} />
                <input
                  data-testid="cross-border-category-l1"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.categoryL1}
                  onChange={(event) => setFormState((current) => ({ ...current, categoryL1: event.target.value }))}
                  placeholder={localize(locale, "例如：Beauty", "Example: Beauty")}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "类目 L2", "Category L2")} />
                <input
                  data-testid="cross-border-category-l2"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.categoryL2}
                  onChange={(event) => setFormState((current) => ({ ...current, categoryL2: event.target.value }))}
                  placeholder={localize(locale, "例如：Hair Dryers", "Example: Hair Dryers")}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "履约模式", "Fulfillment mode")} />
                <select
                  data-testid="cross-border-fulfillment-mode"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.fulfillmentMode}
                  onChange={(event) => setFormState((current) => ({ ...current, fulfillmentMode: event.target.value as SetupState["fulfillmentMode"] }))}
                >
                  <option value="platform_fulfilled">{localize(locale, "平台履约", "Platform fulfilled")}</option>
                  <option value="third_party_warehouse">{localize(locale, "第三方仓", "3PL warehouse")}</option>
                  <option value="self_fulfilled">{localize(locale, "自发货", "Self fulfilled")}</option>
                  <option value="hybrid">{localize(locale, "混合履约", "Hybrid")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "价格带", "Price band")} />
                <input
                  data-testid="cross-border-price-band"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.priceBand}
                  onChange={(event) => setFormState((current) => ({ ...current, priceBand: event.target.value }))}
                  placeholder={localize(locale, "例如：US$19-29", "Example: US$19-29")}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "投放强度", "Ad usage")} />
                <select
                  data-testid="cross-border-ad-usage"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.adUsage}
                  onChange={(event) => setFormState((current) => ({ ...current, adUsage: event.target.value as SetupState["adUsage"] }))}
                >
                  <option value="none">{localize(locale, "不投放", "No ads")}</option>
                  <option value="light">{localize(locale, "轻投放", "Light")}</option>
                  <option value="active">{localize(locale, "持续投放", "Active")}</option>
                  <option value="aggressive">{localize(locale, "激进投放", "Aggressive")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "客服模式", "Customer service")} />
                <select
                  data-testid="cross-border-customer-service-mode"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.customerServiceMode}
                  onChange={(event) => setFormState((current) => ({ ...current, customerServiceMode: event.target.value as SetupState["customerServiceMode"] }))}
                >
                  <option value="solo_inbox">{localize(locale, "单人处理", "Solo inbox")}</option>
                  <option value="shared_team">{localize(locale, "团队协作", "Shared team")}</option>
                  <option value="outsourced">{localize(locale, "外包客服", "Outsourced")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "监控深度", "Monitoring depth")} />
                <select
                  data-testid="cross-border-monitoring-depth"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={formState.monitoringDepth}
                  onChange={(event) => setFormState((current) => ({ ...current, monitoringDepth: event.target.value as SetupState["monitoringDepth"] }))}
                >
                  <option value="lean">{localize(locale, "精简", "Lean")}</option>
                  <option value="standard">{localize(locale, "标准", "Standard")}</option>
                  <option value="deep">{localize(locale, "深度", "Deep")}</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <FieldLabel
                label={localize(locale, "盯盘目标", "Watch targets")}
                hint={localize(locale, "一行一个，写类目、关键词、竞品店铺或产品。", "One per line. Use category terms, keywords, competitor stores, or products.")}
              />
              <textarea
                data-testid="cross-border-watch-targets"
                className="min-h-[132px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-3 text-sm text-[color:var(--color-text-primary)]"
                value={formState.watchTargetsText}
                onChange={(event) => setFormState((current) => ({ ...current, watchTargetsText: event.target.value }))}
                placeholder={localize(locale, "例如：Hair Dryers Top 10\nDyson Airstrait\ntravel hair dryer", "Example: Hair Dryers Top 10\nDyson Airstrait\ntravel hair dryer")}
              />
            </div>

            <div className="space-y-2">
              <FieldLabel
                label={localize(locale, "竞品目标", "Competitor targets")}
                hint={localize(locale, "一行一个，格式：店铺名 | 商品名。", "One per line. Format: Seller | Product.")}
              />
              <textarea
                data-testid="cross-border-competitor-targets"
                className="min-h-[132px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-3 text-sm text-[color:var(--color-text-primary)]"
                value={formState.competitorTargetsText}
                onChange={(event) => setFormState((current) => ({ ...current, competitorTargetsText: event.target.value }))}
                placeholder={localize(locale, "例如：Store A | Nano Hair Dryer\nStore B | Brush Dryer Combo", "Example: Store A | Nano Hair Dryer\nStore B | Brush Dryer Combo")}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <ActionButton data-testid="cross-border-save-profile" onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>
                {saveProfile.isPending ? localize(locale, "保存中…", "Saving…") : localize(locale, "保存经营设置", "Save operating profile")}
              </ActionButton>
              <ActionButton
                data-testid="cross-border-enable-default-workflows"
                tone="secondary"
                onClick={() => applyDefaultWorkflows()}
                disabled={isApplyingDefaultWorkflows || (!profileQuery.data && !snapshotQuery.data?.profile)}
              >
                {isApplyingDefaultWorkflows
                  ? localize(locale, "启用中…", "Enabling…")
                  : localize(locale, "启用默认稳定流程", "Enable default stable workflows")}
              </ActionButton>
              <ActionButton
                data-testid="cross-border-open-assistant-direct"
                tone="secondary"
                onClick={openAssistant}
                disabled={!profileQuery.data && !snapshotQuery.data?.profile}
              >
                {localize(locale, "去助手看交接", "Open assistant handoff")}
              </ActionButton>
              <ActionButton data-testid="cross-border-back-to-packs" tone="secondary" onClick={() => navigate("/packs")}>
                {localize(locale, "回到行业包库", "Back to packs")}
              </ActionButton>
            </div>
          </div>
        </ShellCard>

        <ShellCard title={localize(locale, "导入第一批经营证据", "Import the first batch of operating evidence")}>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "导入类型", "Import kind")} />
                <select
                  data-testid="cross-border-import-kind"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={importPayload.kind}
                  onChange={(event) => setImportPayload((current) => ({ ...current, kind: event.target.value as CrossBorderImportInput["kind"] }))}
                >
                  <option value="store_report">{localize(locale, "店铺报表 / 晨检备注", "Store report / morning notes")}</option>
                  <option value="category_watch_seed">{localize(locale, "类目和竞品监控", "Category and competitor watch")}</option>
                  <option value="price_check_seed">{localize(locale, "价格带 / 跟价对比", "Price gap / match review")}</option>
                  <option value="customer_service_notes">{localize(locale, "客服和售后问题", "Customer service and returns")}</option>
                  <option value="listing_review_notes">{localize(locale, "图片和详情页质量", "Image and listing quality")}</option>
                  <option value="public_link_seed">{localize(locale, "公开链接种子", "Public link seeds")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <FieldLabel label={localize(locale, "导入来源", "Source type")} />
                <select
                  data-testid="cross-border-import-source"
                  className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                  value={importPayload.source}
                  onChange={(event) => setImportPayload((current) => ({ ...current, source: event.target.value as CrossBorderImportInput["source"] }))}
                >
                  <option value="paste">{localize(locale, "粘贴文本", "Paste text")}</option>
                  <option value="csv_upload">{localize(locale, "CSV 上传", "CSV upload")}</option>
                  <option value="image_upload">{localize(locale, "图片上传", "Image upload")}</option>
                  <option value="public_link">{localize(locale, "公开链接", "Public links")}</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <FieldLabel label={localize(locale, "标题", "Title")} />
              <input
                data-testid="cross-border-import-title"
                className="min-h-[44px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
                value={importPayload.title}
                onChange={(event) => setImportPayload((current) => ({ ...current, title: event.target.value }))}
                placeholder={localize(locale, "例如：2026-04-08 TikTok Shop 晨检", "Example: 2026-04-08 TikTok Shop morning check")}
              />
            </div>

            <div className="space-y-2">
              <FieldLabel label={localize(locale, "文本 / CSV 内容 / 备注", "Text / CSV content / notes")} />
              <textarea
                data-testid="cross-border-import-raw-text"
                className="min-h-[148px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-3 text-sm text-[color:var(--color-text-primary)]"
                value={importPayload.rawText ?? ""}
                onChange={(event) => setImportPayload((current) => ({ ...current, rawText: event.target.value }))}
                placeholder={localize(locale, "可以粘贴店铺报表摘要、客服问题、类目 Top 10 观察笔记、价格对比或 listing 审核记录。", "Paste store report notes, customer issues, Top 10 category observations, price comparisons, or listing review notes here.")}
              />
            </div>

            <div className="space-y-2">
              <FieldLabel label={localize(locale, "公开链接（可选）", "Public links (optional)")} hint={localize(locale, "公开榜单、公开商品页、公开价格页都可以。", "Use public ranking pages, product pages, or price pages only.")} />
              <textarea
                data-testid="cross-border-import-public-links"
                className="min-h-[88px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-3 text-sm text-[color:var(--color-text-primary)]"
                value={publicLinksText}
                onChange={(event) => setPublicLinksText(event.target.value)}
                placeholder={localize(locale, "一行一个链接。", "One link per line.")}
              />
            </div>

            <div className="space-y-2">
              <FieldLabel label={localize(locale, "文件上传（CSV / 文本 / 图片）", "File upload (CSV / text / image)")} hint={localize(locale, "CSV/文本会自动读取，图片会记录文件名并配合你的备注一起进入分析。", "CSV/text files are read automatically. Images are stored as file-name evidence plus your notes.")} />
              <input
                data-testid="cross-border-import-files"
                type="file"
                multiple
                accept=".csv,.txt,image/*"
                onChange={async (event) => {
                  try {
                    await handleFileSelection(event.target.files);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : localize(locale, "读取文件失败", "Failed to read file"));
                  }
                }}
                className="block w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-3 text-sm text-[color:var(--color-text-primary)]"
              />
              {importPayload.fileNames && importPayload.fileNames.length > 0 ? (
                <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-3 text-xs text-[color:var(--color-text-secondary)]">
                  {importPayload.fileNames.join(" · ")}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <ActionButton data-testid="cross-border-import-submit" onClick={() => importMutation.mutate()} disabled={importMutation.isPending}>
                {importMutation.isPending ? localize(locale, "导入中…", "Importing…") : localize(locale, "加入经营板", "Add to operating board")}
              </ActionButton>
              <ActionButton data-testid="cross-border-open-chat" tone="secondary" onClick={() => navigate(buildPackChatHref(CROSS_BORDER_PACK_ID))}>
                {localize(locale, "先去聊天继续分析", "Continue in chat")}
              </ActionButton>
            </div>
          </div>
        </ShellCard>
      </div>

      {snapshotQuery.data ? (
        <CrossBorderActionBoard
          snapshot={snapshotQuery.data}
          onOpenSetup={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          onOpenAssistant={openAssistant}
          onOpenWorkflowTemplate={(templateId) => navigate(`/workflows/builder?templateId=${encodeURIComponent(templateId)}`)}
          onOpenManagedWorkflow={(workflowId) => navigate(`/workflows/builder?workflowId=${encodeURIComponent(workflowId)}`)}
          onApplyDefaultWorkflows={() => applyDefaultWorkflows()}
          onSetWorkflowEnabled={setWorkflowEnabled}
          isApplyingDefaultWorkflows={isApplyingDefaultWorkflows}
          togglingWorkflowId={togglingWorkflowId}
        />
      ) : null}

      <ShellCard title={localize(locale, "安装后的默认路径", "What happens after setup")}>
        <div className="grid gap-3 lg:grid-cols-4">
          {[
            localize(locale, "1. 保存经营画像", "1. Save the operating profile"),
            localize(locale, "2. 导入第一批证据", "2. Import the first evidence batch"),
            localize(locale, "3. 看首页动作板和助手交接", "3. Use the home board and assistant handoff"),
            localize(locale, "4. 7 / 30 天后调优默认流程", "4. Tune the workflows after 7 / 30 days"),
          ].map((item) => (
            <div key={item} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm text-[color:var(--color-text-primary)]">
              {item}
            </div>
          ))}
        </div>
      </ShellCard>

      {pack ? (
        <ShellCard title={localize(locale, "当前包定位", "Current pack position")}>
          <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "跨境包现在不只是一个入口。它会先建立 operating profile，再基于公开榜单、商品页、自家报表和手工种子，生成默认 daily / weekly workflow，并把结果压回首页和助手交接。",
              "The cross-border pack is no longer just an entry point. It builds an operating profile first, then turns public rankings, product pages, your own reports, and manual seeds into default daily and weekly workflows that feed back into Home and Assistant.",
            )}
          </p>
        </ShellCard>
      ) : null}

      {searchParams.get("mode") === "adjust" ? (
        <ShellCard title={localize(locale, "当前是调整模式", "You are editing an existing operating profile")}>
          <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {localize(locale, "这次不是首次安装，而是在已有流程上微调盯盘目标、竞品、类目和节奏。", "This is not a first-time install. You are tuning targets, competitors, categories, and workflow cadence on top of an existing profile.")}
          </p>
        </ShellCard>
      ) : null}
    </div>
  );
}
