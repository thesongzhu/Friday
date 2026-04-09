import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type { JsonObject } from "#workflows";
import type { FridayUixUserPreferenceRepository } from "../../uix/persistence/friday-uix-user-preference-repository.js";
import type { FridayWorkflowBuilderRuntime } from "../../workflows/builder/runtime/friday-workflow-builder-runtime.js";
import type { FridayWorkflowProductService } from "../../workflows/services/friday-workflow-product-service.js";
import type { FridayWorkflowRuntime } from "../../workflows/runtime/friday-workflow-runtime.types.js";
import type {
  FridayCrossBorderAdUsage,
  FridayCrossBorderBoard,
  FridayCrossBorderCompetitorTarget,
  FridayCrossBorderCustomerServiceMode,
  FridayCrossBorderFulfillmentMode,
  FridayCrossBorderImportBatch,
  FridayCrossBorderImportKind,
  FridayCrossBorderImportSource,
  FridayCrossBorderMonitoringDepth,
  FridayCrossBorderOperatingProfile,
  FridayCrossBorderRecommendation,
  FridayCrossBorderRecommendationTone,
  FridayCrossBorderRegionFocus,
  FridayCrossBorderSnapshot,
  FridayCrossBorderSourcePlatform,
  FridayCrossBorderStoreStage,
  FridayCrossBorderWatchTarget,
  FridayCrossBorderWorkflowAutomationState,
  FridayCrossBorderWorkflowGuidancePolicy,
  FridayCrossBorderWorkflowId,
  FridayCrossBorderWorkflowRecommendation,
} from "./friday-cross-border-pack.types.js";
import { FRIDAY_CROSS_BORDER_PACK_ID } from "./friday-cross-border-pack.types.js";
import { getFridayCrossBorderWorkflowCatalogEntry } from "./friday-cross-border-workflow-catalog.js";

const PROFILE_KEY = "packs.cross_border.profile";
const IMPORTS_KEY = "packs.cross_border.imports";
const WORKFLOW_AUTOMATIONS_KEY = "packs.cross_border.workflow_automations";
const MAX_IMPORT_BATCHES = 40;
const MAX_LINKS_PER_IMPORT = 20;
const MAX_FILE_NAMES_PER_IMPORT = 12;

const DAILY_WORKFLOWS: FridayCrossBorderWorkflowId[] = [
  "daily-store-health-check",
  "daily-category-top10-watch",
  "daily-price-gap-watch",
  "daily-customer-service-sweep",
];
const WEEKLY_WORKFLOWS: FridayCrossBorderWorkflowId[] = [
  "weekly-hot-product-review",
  "weekly-operating-profile-tune",
];
const DEFAULT_WORKFLOWS: FridayCrossBorderWorkflowId[] = [
  ...DAILY_WORKFLOWS,
  ...WEEKLY_WORKFLOWS,
];

const SEA_STORE_HEALTH_KEYWORDS = ["collection", "cancel", "refund", "退货", "取消", "履约", "客服", "shop performance"];
const NA_STORE_HEALTH_KEYWORDS = ["return", "refund", "price", "coupon", "fba", "remote fulfillment", "退货", "促销"];
const PRICE_KEYWORDS = ["price", "coupon", "discount", "shipping", "运费", "价格", "促销"];
const CUSTOMER_SERVICE_KEYWORDS = ["refund", "return", "complaint", "bad review", "客服", "差评", "退款", "退货"];
const LISTING_KEYWORDS = ["image", "hero", "layout", "listing", "首图", "详情", "排版", "素材"];
const SPIKE_KEYWORDS = ["spike", "爆", "爆单", "突然", "trending", "hot", "rise", "增长"];
const CROSS_BORDER_MANAGED_WORKFLOW_TAG = "cross-border-pack-managed";
const CROSS_BORDER_PRESET_TAG_PREFIX = "cross-border-preset:";

export interface FridayCrossBorderOperatingProfileInput {
  regionFocus: FridayCrossBorderRegionFocus;
  storeStage: FridayCrossBorderStoreStage;
  categoryL1: string;
  categoryL2: string;
  fulfillmentMode: FridayCrossBorderFulfillmentMode;
  priceBand: string;
  adUsage: FridayCrossBorderAdUsage;
  customerServiceMode: FridayCrossBorderCustomerServiceMode;
  monitoringDepth: FridayCrossBorderMonitoringDepth;
  watchTargets: FridayCrossBorderWatchTarget[];
  competitorTargets: FridayCrossBorderCompetitorTarget[];
}

export interface FridayCrossBorderImportBatchInput {
  kind: FridayCrossBorderImportKind;
  source: FridayCrossBorderImportSource;
  title: string;
  rawText?: string;
  publicLinks?: string[];
  fileNames?: string[];
}

export interface FridayCrossBorderWorkflowPresetApplyInput {
  workflowIds?: FridayCrossBorderWorkflowId[];
  timezone: string;
}

export interface FridayCrossBorderWorkflowPresetToggleInput {
  workflowId: FridayCrossBorderWorkflowId;
  enabled: boolean;
  timezone?: string;
}

export interface FridayCrossBorderPackService {
  getProfile(input: { userId: string }): FridayCrossBorderOperatingProfile | null;
  upsertProfile(input: { userId: string; profile: FridayCrossBorderOperatingProfileInput }): FridayCrossBorderOperatingProfile;
  importBatch(input: { userId: string; batch: FridayCrossBorderImportBatchInput }): FridayCrossBorderImportBatch;
  getSnapshot(input: { userId: string }): FridayCrossBorderSnapshot;
  applyWorkflowPreset(input: { userId: string; preset: FridayCrossBorderWorkflowPresetApplyInput }): Promise<FridayCrossBorderSnapshot>;
  setWorkflowPresetEnabled(input: { userId: string; preset: FridayCrossBorderWorkflowPresetToggleInput }): Promise<FridayCrossBorderSnapshot>;
  buildWorkflowInputContext(input: { userId: string; managedWorkflowId: string }): JsonObject | null;
}

export interface CreateFridayCrossBorderPackServiceDeps {
  db: FridaySqliteLayer;
  preferenceRepo: FridayUixUserPreferenceRepository;
  idGenerator: () => string;
  nowIso: () => string;
  workflowRuntime: FridayWorkflowRuntime;
  workflowBuilderRuntime: FridayWorkflowBuilderRuntime;
  workflowProductService: FridayWorkflowProductService;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

function normalizeWatchTargets(value: unknown): FridayCrossBorderWatchTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const id = asString(item.id);
    const label = asString(item.label);
    const type = asString(item.type);
    if (!id || !label || !type || !["category", "seller", "product", "keyword"].includes(type)) {
      return [];
    }
    const platform = asString(item.platform);
    return [{
      id,
      label,
      type: type as FridayCrossBorderWatchTarget["type"],
      ...(platform ? { platform: platform as FridayCrossBorderSourcePlatform } : {}),
      ...(asString(item.notes) ? { notes: asString(item.notes)! } : {}),
    }];
  });
}

function normalizeCompetitorTargets(value: unknown): FridayCrossBorderCompetitorTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const id = asString(item.id);
    const sellerName = asString(item.sellerName);
    const platform = asString(item.platform);
    if (!id || !sellerName || !platform) {
      return [];
    }
    return [{
      id,
      sellerName,
      platform: platform as FridayCrossBorderSourcePlatform,
      ...(asString(item.productName) ? { productName: asString(item.productName)! } : {}),
      ...(asString(item.listingUrl) ? { listingUrl: asString(item.listingUrl)! } : {}),
      ...(asString(item.notes) ? { notes: asString(item.notes)! } : {}),
    }];
  });
}

function normalizeProfile(value: unknown): FridayCrossBorderOperatingProfile | null {
  if (!isObject(value)) {
    return null;
  }
  const regionFocus = asString(value.regionFocus);
  const platformPrimary = asString(value.platformPrimary);
  const storeStage = asString(value.storeStage);
  const categoryL1 = asString(value.categoryL1);
  const categoryL2 = asString(value.categoryL2);
  const fulfillmentMode = asString(value.fulfillmentMode);
  const priceBand = asString(value.priceBand);
  const adUsage = asString(value.adUsage);
  const customerServiceMode = asString(value.customerServiceMode);
  const monitoringDepth = asString(value.monitoringDepth);
  const createdAt = asString(value.createdAt);
  const updatedAt = asString(value.updatedAt);
  if (
    !regionFocus
    || !platformPrimary
    || !storeStage
    || !categoryL1
    || !categoryL2
    || !fulfillmentMode
    || !priceBand
    || !adUsage
    || !customerServiceMode
    || !monitoringDepth
    || !createdAt
    || !updatedAt
  ) {
    return null;
  }

  const workflowPreset = normalizeStringList(value.workflowPreset, DEFAULT_WORKFLOWS.length)
    .filter((item): item is FridayCrossBorderWorkflowId => DEFAULT_WORKFLOWS.includes(item as FridayCrossBorderWorkflowId));
  const adaptationStateValue = isObject(value.adaptationState) ? value.adaptationState : {};
  const firstReviewDueAt = asString(adaptationStateValue.firstReviewDueAt);
  const stableReviewDueAt = asString(adaptationStateValue.stableReviewDueAt);
  const status = asString(adaptationStateValue.status);
  if (!firstReviewDueAt || !stableReviewDueAt || !status) {
    return null;
  }

  return {
    packId: FRIDAY_CROSS_BORDER_PACK_ID,
    regionFocus: regionFocus as FridayCrossBorderRegionFocus,
    platformPrimary: platformPrimary as FridayCrossBorderSourcePlatform,
    ...(asString(value.platformSecondary) ? { platformSecondary: asString(value.platformSecondary)! as FridayCrossBorderSourcePlatform } : {}),
    storeStage: storeStage as FridayCrossBorderStoreStage,
    categoryL1,
    categoryL2,
    fulfillmentMode: fulfillmentMode as FridayCrossBorderFulfillmentMode,
    priceBand,
    adUsage: adUsage as FridayCrossBorderAdUsage,
    customerServiceMode: customerServiceMode as FridayCrossBorderCustomerServiceMode,
    monitoringDepth: monitoringDepth as FridayCrossBorderMonitoringDepth,
    watchTargets: normalizeWatchTargets(value.watchTargets),
    competitorTargets: normalizeCompetitorTargets(value.competitorTargets),
    workflowPreset: workflowPreset.length > 0 ? workflowPreset : [...DEFAULT_WORKFLOWS],
    adaptationState: {
      status: status as FridayCrossBorderOperatingProfile["adaptationState"]["status"],
      firstReviewDueAt,
      stableReviewDueAt,
      ...(asString(adaptationStateValue.lastRecommendedAt)
        ? { lastRecommendedAt: asString(adaptationStateValue.lastRecommendedAt)! }
        : {}),
    },
    createdAt,
    updatedAt,
  };
}

function normalizeImportBatches(value: unknown): FridayCrossBorderImportBatch[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const id = asString(item.id);
    const kind = asString(item.kind);
    const source = asString(item.source);
    const title = asString(item.title);
    const createdAt = asString(item.createdAt);
    if (!id || !kind || !source || !title || !createdAt) {
      return [];
    }
    return [{
      id,
      kind: kind as FridayCrossBorderImportKind,
      source: source as FridayCrossBorderImportSource,
      title,
      ...(asString(item.rawText) ? { rawText: asString(item.rawText)! } : {}),
      publicLinks: normalizeStringList(item.publicLinks, MAX_LINKS_PER_IMPORT),
      fileNames: normalizeStringList(item.fileNames, MAX_FILE_NAMES_PER_IMPORT),
      createdAt,
    }];
  });
}

interface FridayCrossBorderWorkflowAutomationRecord {
  workflowId: FridayCrossBorderWorkflowId;
  templateId: FridayCrossBorderWorkflowAutomationState["templateId"];
  managedWorkflowId: string;
  managedWorkflowVersionId?: string;
  managedWorkflowSlug: string;
  managedWorkflowName: string;
  status: FridayCrossBorderWorkflowAutomationState["status"];
  schedule: {
    cron: string;
    timezone: string;
  };
  triggerRegistrationId?: string;
  nextRunAt?: string;
  lastPublishedAt: string;
  lastSyncedAt: string;
}

function normalizeWorkflowAutomationRecords(value: unknown): FridayCrossBorderWorkflowAutomationRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const workflowId = asString(item.workflowId);
    const templateId = asString(item.templateId);
    const managedWorkflowId = asString(item.managedWorkflowId);
    const managedWorkflowSlug = asString(item.managedWorkflowSlug);
    const managedWorkflowName = asString(item.managedWorkflowName);
    const status = asString(item.status);
    const lastPublishedAt = asString(item.lastPublishedAt);
    const lastSyncedAt = asString(item.lastSyncedAt);
    const scheduleValue = isObject(item.schedule) ? item.schedule : null;
    const cron = scheduleValue ? asString(scheduleValue.cron) : null;
    const timezone = scheduleValue ? asString(scheduleValue.timezone) : null;
    if (
      !workflowId
      || !managedWorkflowId
      || !templateId
      || !managedWorkflowSlug
      || !managedWorkflowName
      || !status
      || !lastPublishedAt
      || !lastSyncedAt
      || !cron
      || !timezone
    ) {
      return [];
    }
    return [{
      workflowId: workflowId as FridayCrossBorderWorkflowId,
      templateId: templateId as FridayCrossBorderWorkflowAutomationState["templateId"],
      managedWorkflowId,
      ...(asString(item.managedWorkflowVersionId) ? { managedWorkflowVersionId: asString(item.managedWorkflowVersionId)! } : {}),
      managedWorkflowSlug,
      managedWorkflowName,
      status: status as FridayCrossBorderWorkflowAutomationState["status"],
      schedule: { cron, timezone },
      ...(asString(item.triggerRegistrationId) ? { triggerRegistrationId: asString(item.triggerRegistrationId)! } : {}),
      ...(asString(item.nextRunAt) ? { nextRunAt: asString(item.nextRunAt)! } : {}),
      lastPublishedAt,
      lastSyncedAt,
    }];
  });
}

function parseManagedWorkflowPresetId(tags: string[]): FridayCrossBorderWorkflowId | null {
  const presetTag = tags.find((tag) => tag.startsWith(CROSS_BORDER_PRESET_TAG_PREFIX));
  if (!presetTag) {
    return null;
  }
  const workflowId = presetTag.slice(CROSS_BORDER_PRESET_TAG_PREFIX.length);
  return DEFAULT_WORKFLOWS.includes(workflowId as FridayCrossBorderWorkflowId)
    ? workflowId as FridayCrossBorderWorkflowId
    : null;
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function resolvePlatforms(regionFocus: FridayCrossBorderRegionFocus): {
  platformPrimary: FridayCrossBorderSourcePlatform;
  platformSecondary?: FridayCrossBorderSourcePlatform;
} {
  if (regionFocus === "sea_tiktok") {
    return {
      platformPrimary: "tiktok_shop",
      platformSecondary: "public_web",
    };
  }
  return {
    platformPrimary: "amazon",
    platformSecondary: "public_web",
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function buildDefaultWatchTargets(input: FridayCrossBorderOperatingProfileInput, idGenerator: () => string): FridayCrossBorderWatchTarget[] {
  const defaults: FridayCrossBorderWatchTarget[] = [
    {
      id: idGenerator(),
      type: "category",
      label: `${input.categoryL1} / ${input.categoryL2}`,
      platform: input.regionFocus === "sea_tiktok" ? "tiktok_shop" : "amazon",
      notes: input.regionFocus === "sea_tiktok"
        ? "Track Top 10 sellers/products and sudden spikes in this category."
        : "Track Top 10 category leaders and changes in price bands.",
    },
  ];
  return uniqueById([...defaults, ...input.watchTargets]).slice(0, 8);
}

function buildDefaultWorkflowPreset(): FridayCrossBorderWorkflowId[] {
  return [...DEFAULT_WORKFLOWS];
}

function severityRank(tone: FridayCrossBorderRecommendationTone): number {
  switch (tone) {
    case "urgent":
      return 3;
    case "watch":
      return 2;
    default:
      return 1;
  }
}

function detectTone(text: string): FridayCrossBorderRecommendationTone {
  const lower = text.toLowerCase();
  if (
    SEA_STORE_HEALTH_KEYWORDS.some((keyword) => lower.includes(keyword))
    || NA_STORE_HEALTH_KEYWORDS.some((keyword) => lower.includes(keyword))
  ) {
    return "urgent";
  }
  if (
    PRICE_KEYWORDS.some((keyword) => lower.includes(keyword))
    || CUSTOMER_SERVICE_KEYWORDS.some((keyword) => lower.includes(keyword))
    || LISTING_KEYWORDS.some((keyword) => lower.includes(keyword))
  ) {
    return "watch";
  }
  return "neutral";
}

function compactLines(text: string | undefined, maxItems: number): string[] {
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .slice(0, maxItems);
}

function joinSeedLabels(items: string[], fallback: string): string {
  return items.length > 0 ? items.join(" / ") : fallback;
}

function findLatestImport(imports: FridayCrossBorderImportBatch[], kinds: FridayCrossBorderImportKind[]): FridayCrossBorderImportBatch | null {
  return [...imports]
    .filter((item) => kinds.includes(item.kind))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0] ?? null;
}

function buildBoard(input: {
  title: string;
  summary: string;
  bullets: string[];
  tone: FridayCrossBorderRecommendationTone;
}): FridayCrossBorderBoard {
  return {
    title: input.title,
    summary: input.summary,
    bullets: input.bullets.slice(0, 4),
    tone: input.tone,
  };
}

function keywordBoards(profile: FridayCrossBorderOperatingProfile, imports: FridayCrossBorderImportBatch[]): {
  storeHealth: FridayCrossBorderBoard;
  categoryWatch: FridayCrossBorderBoard;
  spikingProducts: FridayCrossBorderBoard;
  priceGapBoard: FridayCrossBorderBoard;
  listingQualityBoard: FridayCrossBorderBoard;
  customerServiceBoard: FridayCrossBorderBoard;
} {
  const storeImport = findLatestImport(imports, ["store_report"]);
  const categoryImport = findLatestImport(imports, ["category_watch_seed", "public_link_seed"]);
  const priceImport = findLatestImport(imports, ["price_check_seed", "public_link_seed"]);
  const listingImport = findLatestImport(imports, ["listing_review_notes"]);
  const customerImport = findLatestImport(imports, ["customer_service_notes"]);

  const watchLabels = profile.watchTargets.map((target) => target.label);
  const competitorLabels = profile.competitorTargets.map((target) => target.productName ?? target.sellerName);

  const storeBullets = compactLines(storeImport?.rawText, 4);
  const categoryBullets = [
    ...compactLines(categoryImport?.rawText, 3),
    ...watchLabels.slice(0, 2).map((label) => `Watch target: ${label}`),
  ].slice(0, 4);
  const spikeBullets = [
    ...compactLines(categoryImport?.rawText, 4).filter((line) => SPIKE_KEYWORDS.some((keyword) => line.toLowerCase().includes(keyword))),
    ...watchLabels.slice(0, 2).map((label) => `Check breakout velocity in ${label}`),
  ].slice(0, 4);
  const priceBullets = [
    ...compactLines(priceImport?.rawText, 3),
    ...competitorLabels.slice(0, 2).map((label) => `Compare against ${label}`),
  ].slice(0, 4);
  const listingBullets = [
    ...compactLines(listingImport?.rawText, 3),
    ...(listingImport?.fileNames ?? []).slice(0, 2).map((name) => `Uploaded image reference: ${name}`),
  ].slice(0, 4);
  const customerBullets = [
    ...compactLines(customerImport?.rawText, 3),
    ...(customerImport?.publicLinks ?? []).slice(0, 1).map((link) => `Case link: ${link}`),
  ].slice(0, 4);

  return {
    storeHealth: buildBoard({
      title: profile.regionFocus === "sea_tiktok" ? "SEA 店铺健康" : "北美店铺健康",
      summary: storeImport?.rawText
        ? "Latest imported store report has been reduced into today's operating priorities."
        : profile.regionFocus === "sea_tiktok"
          ? "Prioritize shop performance score, cancellation risk, collection speed, and reply speed."
          : "Prioritize returns, remote fulfillment, price band drift, and review pressure.",
      bullets: storeBullets.length > 0
        ? storeBullets
        : [
          profile.regionFocus === "sea_tiktok"
            ? "Check Awaiting Collection backlog and cancellation pressure."
            : "Check returns, late-delivery pressure, and FBA / remote-fulfillment exceptions.",
          profile.regionFocus === "sea_tiktok"
            ? "Review customer reply speed and SPS-sensitive issues."
            : "Review refund velocity, return reasons, and review trend shifts.",
        ],
      tone: detectTone(storeImport?.rawText ?? profile.regionFocus),
    }),
    categoryWatch: buildBoard({
      title: "类目 Top 10 监控",
      summary: `Track ${joinSeedLabels(watchLabels, `${profile.categoryL1} / ${profile.categoryL2}`)} every day and compare seller/product movement.`,
      bullets: categoryBullets.length > 0
        ? categoryBullets
        : [
          `Watch the top sellers in ${profile.categoryL1} / ${profile.categoryL2}.`,
          "Record changes in hero image, benefit stack, and price band.",
        ],
      tone: detectTone(categoryImport?.rawText ?? profile.categoryL2),
    }),
    spikingProducts: buildBoard({
      title: "突然升温商品",
      summary: "Capture products that are rising faster than the category baseline before they become fully crowded.",
      bullets: spikeBullets.length > 0
        ? spikeBullets
        : [
          "Flag products with rapidly repeated mentions, reposts, or rank movement.",
          "Separate real demand spikes from short-lived promo noise before following.",
        ],
      tone: detectTone(categoryImport?.rawText ?? "spike watch"),
    }),
    priceGapBoard: buildBoard({
      title: "价格带与跟价建议",
      summary: "Compare your SKU price band, coupon stack, shipping promise, and bundle framing against direct competitors.",
      bullets: priceBullets.length > 0
        ? priceBullets
        : [
          `Review competitor set: ${joinSeedLabels(competitorLabels, "No competitor target yet")}.`,
          "Do not follow price cuts blindly when your listing or fulfillment quality is weaker.",
        ],
      tone: detectTone(priceImport?.rawText ?? "price review"),
    }),
    listingQualityBoard: buildBoard({
      title: "图片质量与排版",
      summary: "Audit image quality, hero image clarity, detail-page pacing, and localization fit before changing price or spend.",
      bullets: listingBullets.length > 0
        ? listingBullets
        : [
          "Check whether the hero image communicates the key benefit in one glance.",
          "Review whether the detail sequence matches the target market's buying concerns.",
        ],
      tone: detectTone(listingImport?.rawText ?? "listing review"),
    }),
    customerServiceBoard: buildBoard({
      title: "客服与售后",
      summary: "Group support issues by root cause so refund pressure and bad-review risk do not stay hidden in chat history.",
      bullets: customerBullets.length > 0
        ? customerBullets
        : [
          "Cluster refund, return, and complaint issues by root cause.",
          "Separate product-quality issues from expectation mismatch and logistics delays.",
        ],
      tone: detectTone(customerImport?.rawText ?? "customer service"),
    }),
  };
}

function normalizeSlugPart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workflow";
}

function buildManagedWorkflowSlug(input: {
  userId: string;
  regionFocus: FridayCrossBorderRegionFocus;
  workflowId: FridayCrossBorderWorkflowId;
}): string {
  const userSlug = normalizeSlugPart(input.userId).slice(0, 20);
  return `cross-border-${input.regionFocus.replace(/_/g, "-")}-${input.workflowId}-${userSlug}`.slice(0, 120);
}

function buildManagedWorkflowName(input: {
  profile: FridayCrossBorderOperatingProfile;
  workflowId: FridayCrossBorderWorkflowId;
}): string {
  const entry = getFridayCrossBorderWorkflowCatalogEntry(input.workflowId);
  const regionPrefix = input.profile.regionFocus === "sea_tiktok" ? "SEA" : "NA";
  return `${regionPrefix} · ${entry.titleEn}`;
}

function buildWorkflowSchedule(
  workflowId: FridayCrossBorderWorkflowId,
  timezone: string,
): { cron: string; timezone: string } {
  const entry = getFridayCrossBorderWorkflowCatalogEntry(workflowId);
  return {
    cron: entry.defaultCadence.cron,
    timezone,
  };
}

function hasRecentImport(
  imports: FridayCrossBorderImportBatch[],
  kinds: FridayCrossBorderImportKind[],
  withinDays: number,
  nowIso: string,
): boolean {
  const thresholdMs = new Date(nowIso).getTime() - withinDays * 24 * 60 * 60 * 1000;
  return imports.some((item) => kinds.includes(item.kind) && new Date(item.createdAt).getTime() >= thresholdMs);
}

function buildWorkflowCurrentGuidance(input: {
  workflowId: FridayCrossBorderWorkflowId;
  profile: FridayCrossBorderOperatingProfile;
  imports: FridayCrossBorderImportBatch[];
  nowIso: string;
}): FridayCrossBorderWorkflowGuidancePolicy {
  switch (input.workflowId) {
    case "daily-store-health-check":
      return {
        state: "active_recommended",
        shouldStartPaused: false,
        summary: {
          zh: "默认保持启用。它是跨境包的基础晨检，不依赖深连接也能先跑出当天动作板。",
          en: "Keep this active by default. It is the base morning check and can produce a useful action board even without deep integrations.",
        },
      };
    case "daily-category-top10-watch":
      if (input.profile.watchTargets.length === 0) {
        return {
          state: "pause_recommended",
          shouldStartPaused: true,
          summary: {
            zh: "先暂停，补齐类目或竞品 watch target 后再开。",
            en: "Start paused until category or competitor watch targets have been added.",
          },
        };
      }
      return {
        state: "active_recommended",
        shouldStartPaused: false,
        summary: {
          zh: "默认保持启用，只要 watch target 还有效，就应该每天追踪头部变化。",
          en: "Keep this active while the watch targets remain valid so top-category movement stays visible every day.",
        },
      };
    case "daily-price-gap-watch":
      if (
        input.profile.competitorTargets.length === 0
        && !hasRecentImport(input.imports, ["price_check_seed", "public_link_seed"], 7, input.nowIso)
      ) {
        return {
          state: "pause_recommended",
          shouldStartPaused: true,
          summary: {
            zh: "先暂停，等补齐直接竞品或价格带输入后再启用，避免空跑。",
            en: "Start paused until direct competitors or fresh price-band signals are available to avoid low-signal runs.",
          },
        };
      }
      return {
        state: "active_recommended",
        shouldStartPaused: false,
        summary: {
          zh: "默认启用，但任何真正的调价动作仍然必须人工确认。",
          en: "Keep this active by default, but any actual price move must remain approval-gated.",
        },
      };
    case "daily-customer-service-sweep":
      if (
        input.profile.customerServiceMode === "outsourced"
        && !hasRecentImport(input.imports, ["customer_service_notes"], 7, input.nowIso)
      ) {
        return {
          state: "pause_recommended",
          shouldStartPaused: true,
          summary: {
            zh: "客服完全外包且最近没有新的售后摘要时，先暂停，改为按周复盘。",
            en: "Start paused when support is fully outsourced and no fresh support digest has arrived; review it weekly instead.",
          },
        };
      }
      return {
        state: "active_recommended",
        shouldStartPaused: false,
        summary: {
          zh: "默认启用，把退款、退货、差评和投诉每天收成一份摘要。",
          en: "Keep this active by default so refunds, returns, bad reviews, and complaints become a daily digest instead of scattered tickets.",
        },
      };
    case "weekly-hot-product-review":
      if (
        input.profile.monitoringDepth === "lean"
        && !hasRecentImport(input.imports, ["category_watch_seed", "public_link_seed"], 10, input.nowIso)
      ) {
        return {
          state: "pause_recommended",
          shouldStartPaused: true,
          summary: {
            zh: "当前监控深度偏轻且没有新的类目种子，建议先暂停这条周流程。",
            en: "Start paused when monitoring depth is lean and there are no fresh category seeds this week.",
          },
        };
      }
      return {
        state: "active_recommended",
        shouldStartPaused: false,
        summary: {
          zh: "默认按周启用，用来盯突然升温的商品，但结论只作为人工复核候选清单。",
          en: "Keep this active weekly to watch rising products, but treat the output as a human review shortlist only.",
        },
      };
    case "weekly-operating-profile-tune":
      if (new Date(input.profile.adaptationState.firstReviewDueAt).getTime() > new Date(input.nowIso).getTime()) {
        return {
          state: "hold_until_ready",
          shouldStartPaused: true,
          summary: {
            zh: "先暂停，等到第一个 7 天调优窗口到了再恢复，避免用过早样本调流程。",
            en: "Start paused until the first 7-day tuning window arrives so the workflow is not tuned on an immature sample.",
          },
        };
      }
      if (
        !hasRecentImport(
          input.imports,
          ["store_report", "price_check_seed", "customer_service_notes", "listing_review_notes", "category_watch_seed", "public_link_seed"],
          7,
          input.nowIso,
        )
      ) {
        return {
          state: "pause_recommended",
          shouldStartPaused: true,
          summary: {
            zh: "最近 7 天没有足够新信号时，建议先暂停，等数据更新后再做流程调优。",
            en: "Pause when the last 7 days do not contain enough fresh signals; tune again after new operating evidence arrives.",
          },
        };
      }
      return {
        state: "active_recommended",
        shouldStartPaused: false,
        summary: {
          zh: "默认按周启用，用来判断哪些 daily/weekly 流程该保留、暂停或升级。",
          en: "Keep this active weekly to decide which daily and weekly routines should stay, pause, or be upgraded.",
        },
      };
  }
}

function buildBoardLines(board: FridayCrossBorderBoard | null): string[] {
  if (!board) {
    return [];
  }
  return [
    board.title,
    board.summary,
    ...board.bullets,
  ].filter((line) => line.trim().length > 0);
}

function buildWorkflowInputPayload(input: {
  workflowId: FridayCrossBorderWorkflowId;
  profile: FridayCrossBorderOperatingProfile;
  snapshot: FridayCrossBorderSnapshot;
}): JsonObject {
  const commonHeader = [
    `Operating mode: ${input.profile.regionFocus}`,
    `Category: ${input.profile.categoryL1} / ${input.profile.categoryL2}`,
    `Fulfillment: ${input.profile.fulfillmentMode}`,
    `Price band: ${input.profile.priceBand}`,
    `Ad usage: ${input.profile.adUsage}`,
    `Customer service mode: ${input.profile.customerServiceMode}`,
  ];
  switch (input.workflowId) {
    case "daily-store-health-check":
      return {
        performanceNotes: [
          ...commonHeader,
          ...buildBoardLines(input.snapshot.storeHealth),
          ...input.snapshot.riskClusters.slice(0, 3).map((risk) => `${risk.title}: ${risk.summary}`),
        ].join("\n"),
      };
    case "daily-category-top10-watch":
      return {
        categoryWatchNotes: [
          ...commonHeader,
          ...buildBoardLines(input.snapshot.categoryWatch),
          ...buildBoardLines(input.snapshot.spikingProducts),
        ].join("\n"),
      };
    case "daily-price-gap-watch":
      return {
        priceSignals: [
          ...commonHeader,
          ...buildBoardLines(input.snapshot.priceGapBoard),
          ...input.snapshot.nextActions
            .filter((action) => action.title.includes("价格") || action.summary.includes("价格"))
            .map((action) => `${action.title}: ${action.summary}`),
        ].join("\n"),
      };
    case "daily-customer-service-sweep":
      return {
        serviceNotes: [
          ...commonHeader,
          ...buildBoardLines(input.snapshot.customerServiceBoard),
          ...input.snapshot.riskClusters
            .filter((risk) => risk.title.includes("客服") || risk.title.includes("售后"))
            .map((risk) => `${risk.title}: ${risk.summary}`),
        ].join("\n"),
      };
    case "weekly-hot-product-review":
      return {
        spikeSignals: [
          ...commonHeader,
          ...buildBoardLines(input.snapshot.spikingProducts),
          ...buildBoardLines(input.snapshot.categoryWatch),
        ].join("\n"),
      };
    case "weekly-operating-profile-tune":
      return {
        weeklySignals: [
          ...commonHeader,
          ...buildBoardLines(input.snapshot.storeHealth),
          ...buildBoardLines(input.snapshot.priceGapBoard),
          ...buildBoardLines(input.snapshot.listingQualityBoard),
          ...input.snapshot.nextActions.map((action) => `${action.title}: ${action.summary}`),
        ].join("\n"),
      };
  }
}

function buildWorkflowRecommendations(
  profile: FridayCrossBorderOperatingProfile,
  imports: FridayCrossBorderImportBatch[],
  nowIso: string,
  automationRecords: FridayCrossBorderWorkflowAutomationRecord[],
): FridayCrossBorderWorkflowRecommendation[] {
  const base = DEFAULT_WORKFLOWS.map((workflowId) => {
    const entry = getFridayCrossBorderWorkflowCatalogEntry(workflowId);
    const cadence = DAILY_WORKFLOWS.includes(workflowId) ? "daily" as const : "weekly" as const;
    const automation = automationRecords.find((item) => item.workflowId === workflowId) ?? null;
    const currentGuidance = buildWorkflowCurrentGuidance({
      workflowId,
      profile,
      imports,
      nowIso,
    });
    const rationaleById: Record<FridayCrossBorderWorkflowId, string> = {
      "daily-store-health-check": profile.regionFocus === "sea_tiktok"
        ? "Catch shop-performance and fulfillment pressure before they damage SPS."
        : "Catch fulfillment, return, and price-band drift before they cascade into review or ad losses.",
      "daily-category-top10-watch": "Track the top 10 sellers/products in your target category and compare movement every day.",
      "daily-price-gap-watch": "Keep price, shipping promise, and promo gap visible against direct competitors.",
      "daily-customer-service-sweep": "Do not let refund or complaint patterns hide inside messages and tickets.",
      "weekly-hot-product-review": "Review sudden product momentum weekly before deciding whether to follow.",
      "weekly-operating-profile-tune": "Tune the operating system weekly instead of carrying stale workflows for too long.",
    };
    return {
      id: workflowId,
      templateId: entry.templateId,
      cadence,
      enabledByDefault: profile.workflowPreset.includes(workflowId),
      rationale: rationaleById[workflowId],
      policy: {
        cadence: {
          cron: entry.defaultCadence.cron,
          timezoneMode: "user_local" as const,
          summary: entry.defaultCadence.summary,
        },
        pauseConditions: entry.pauseConditions,
        approvalBoundaries: entry.approvalBoundaries,
        currentGuidance,
      },
      automation: automation
        ? {
            workflowId: automation.workflowId,
            templateId: automation.templateId,
            managedWorkflowId: automation.managedWorkflowId,
            ...(automation.managedWorkflowVersionId ? { managedWorkflowVersionId: automation.managedWorkflowVersionId } : {}),
            managedWorkflowSlug: automation.managedWorkflowSlug,
            managedWorkflowName: automation.managedWorkflowName,
            status: automation.status,
            schedule: automation.schedule,
            ...(automation.triggerRegistrationId ? { triggerRegistrationId: automation.triggerRegistrationId } : {}),
            ...(automation.nextRunAt ? { nextRunAt: automation.nextRunAt } : {}),
            lastPublishedAt: automation.lastPublishedAt,
            lastSyncedAt: automation.lastSyncedAt,
          }
        : null,
    };
  });
  return base;
}

function buildRiskClusters(profile: FridayCrossBorderOperatingProfile, imports: FridayCrossBorderImportBatch[], nowIso: string): FridayCrossBorderRecommendation[] {
  const recommendations: FridayCrossBorderRecommendation[] = [];
  const push = (input: Omit<FridayCrossBorderRecommendation, "id">) => {
    recommendations.push({
      id: `${input.kind}:${recommendations.length + 1}`,
      ...input,
    });
  };

  const recentImports = imports.slice(0, 6);
  for (const batch of recentImports) {
    const tone = detectTone(batch.rawText ?? batch.title);
    if (tone === "neutral") {
      continue;
    }
    const titleByKind: Record<FridayCrossBorderImportKind, string> = {
      store_report: "店铺健康异常需要优先确认",
      category_watch_seed: "类目变化里有需要跟的动作",
      price_check_seed: "价格带和促销差需要重新判断",
      customer_service_notes: "客服与售后问题开始积压",
      listing_review_notes: "图片质量或详情排版需要先修",
      public_link_seed: "公开页面里出现值得盯住的变化",
    };
    push({
      title: titleByKind[batch.kind],
      summary: batch.rawText?.split(/\r?\n/)[0]?.trim() || batch.title,
      tone,
      kind: tone === "urgent" ? "today" : "week",
      requiresApproval: false,
    });
  }

  const now = new Date(nowIso).getTime();
  if (new Date(profile.adaptationState.firstReviewDueAt).getTime() <= now) {
    push({
      title: "该做第一次流程调优了",
      summary: "Friday 已经累计到第一轮调优窗口，建议检查 daily/weekly 流程是否过重或过轻。",
      tone: "watch",
      kind: "tune",
      requiresApproval: false,
    });
  }
  if (new Date(profile.adaptationState.stableReviewDueAt).getTime() <= now) {
    push({
      title: "进入稳定 workflow 调优窗口",
      summary: "现在应该把保留、删除、升级自动化的流程收成一个稳定版本。",
      tone: "watch",
      kind: "tune",
      requiresApproval: false,
    });
  }
  return recommendations
    .sort((left, right) => severityRank(right.tone) - severityRank(left.tone))
    .slice(0, 5);
}

function buildNextActions(
  profile: FridayCrossBorderOperatingProfile,
  risks: FridayCrossBorderRecommendation[],
  nowIso: string,
): FridayCrossBorderRecommendation[] {
  const results: FridayCrossBorderRecommendation[] = [
    {
      id: "next:1",
      title: profile.regionFocus === "sea_tiktok" ? "先做 TikTok Shop 晨检" : "先做 Amazon 晨检",
      summary: profile.regionFocus === "sea_tiktok"
        ? "先看店铺健康、取消压力、客服响应，再决定广告和类目动作。"
        : "先看退货、价格带和履约，再决定广告和 listing 调整。",
      tone: "urgent",
      kind: "today",
      requiresApproval: false,
    },
    {
      id: "next:2",
      title: "更新 Top 10 类目看板",
      summary: `盯住 ${profile.categoryL1} / ${profile.categoryL2} 的头部卖家和突然升温商品。`,
      tone: "watch",
      kind: "today",
      requiresApproval: false,
    },
    {
      id: "next:3",
      title: "补齐价格带与图片质量判断",
      summary: "先确认是否真需要跟价；如果图片或版式弱，先修 listing 再谈价格动作。",
      tone: "watch",
      kind: "week",
      requiresApproval: false,
    },
  ];
  if (profile.customerServiceMode === "solo_inbox") {
    results.push({
      id: "next:4",
      title: "把客服与售后问题先聚类",
      summary: "单人运营时，先把退款、退货、差评和物流类问题分组，避免被即时消息拖着跑。",
      tone: "watch",
      kind: "today",
      requiresApproval: false,
    });
  }
  const approvalCandidate = risks.find((risk) => risk.tone === "urgent");
  if (approvalCandidate) {
    results.push({
      id: "next:5",
      title: "高风险动作先走待确认",
      summary: "涉及价格、客服补偿、激进促销和大改 listing 的动作都先给出建议，不直接执行。",
      tone: "urgent",
      kind: "approval",
      requiresApproval: true,
    });
  }
  if (profile.competitorTargets.length === 0) {
    results.push({
      id: "next:6",
      title: "补齐直接竞品清单后再打开价格带监控",
      summary: "至少补 1-3 个直接竞品或可靠价格种子，否则每日价格带流程会空跑。",
      tone: "watch",
      kind: "today",
      requiresApproval: false,
    });
  }
  if (new Date(profile.adaptationState.firstReviewDueAt).getTime() > new Date(nowIso).getTime()) {
    results.push({
      id: "next:7",
      title: "先稳定运行 7 天，再启用经营系统调优",
      summary: "在第一个调优窗口到来前，优先让 daily 流程积累有效样本。",
      tone: "watch",
      kind: "tune",
      requiresApproval: false,
    });
  }
  return results.slice(0, 5);
}

function buildSnapshot(
  nowIso: string,
  profile: FridayCrossBorderOperatingProfile | null,
  imports: FridayCrossBorderImportBatch[],
  automationRecords: FridayCrossBorderWorkflowAutomationRecord[],
): FridayCrossBorderSnapshot {
  if (!profile) {
    return {
      generatedAt: nowIso,
      profile: null,
      storeHealth: null,
      categoryWatch: null,
      spikingProducts: null,
      priceGapBoard: null,
      listingQualityBoard: null,
      customerServiceBoard: null,
      workflowRecommendations: [],
      riskClusters: [],
      nextActions: [{
        id: "setup:1",
        title: "先完成跨境安装向导",
        summary: "先告诉 Friday 你是东南亚 / TikTok Shop 还是北美 / Amazon，再生成默认 daily/weekly 流程。",
        tone: "watch",
        kind: "today",
        requiresApproval: false,
      }],
      importSummary: {
        lastImportedAt: null,
        totalImports: 0,
        sourceTypes: [],
      },
    };
  }

  const boards = keywordBoards(profile, imports);
  const riskClusters = buildRiskClusters(profile, imports, nowIso);
  const nextActions = buildNextActions(profile, riskClusters, nowIso);
  return {
    generatedAt: nowIso,
    profile,
    ...boards,
    workflowRecommendations: buildWorkflowRecommendations(profile, imports, nowIso, automationRecords),
    riskClusters,
    nextActions,
    importSummary: {
      lastImportedAt: imports[0]?.createdAt ?? null,
      totalImports: imports.length,
      sourceTypes: Array.from(new Set(imports.map((item) => item.source))),
    },
  };
}

function validateProfileInput(input: FridayCrossBorderOperatingProfileInput): void {
  if (!input.categoryL1.trim() || !input.categoryL2.trim()) {
    throw new FridayDomainError("VALIDATION_ERROR", "categoryL1 and categoryL2 are required", { httpStatus: 400 });
  }
  if (!input.priceBand.trim()) {
    throw new FridayDomainError("VALIDATION_ERROR", "priceBand is required", { httpStatus: 400 });
  }
}

function validateImportInput(input: FridayCrossBorderImportBatchInput): void {
  if (!input.title.trim()) {
    throw new FridayDomainError("VALIDATION_ERROR", "title is required", { httpStatus: 400 });
  }
  if (
    (!input.rawText || input.rawText.trim().length === 0)
    && (!input.publicLinks || input.publicLinks.length === 0)
    && (!input.fileNames || input.fileNames.length === 0)
  ) {
    throw new FridayDomainError("VALIDATION_ERROR", "At least one import payload is required", { httpStatus: 400 });
  }
}

export function createFridayCrossBorderPackService(
  deps: CreateFridayCrossBorderPackServiceDeps,
): FridayCrossBorderPackService {
  function readPreference<T>(userId: string, key: string, normalize: (value: unknown) => T | null): T | null {
    return deps.db.withReadConnection((db) => {
      const items = deps.preferenceRepo.listByPrincipal(db, {
        principalId: userId,
        category: "uix",
      });
      const entry = items.find((item) => item.key === key);
      return entry ? normalize(entry.value) : null;
    });
  }

  function writePreference(userId: string, key: string, value: unknown): void {
    deps.db.withWriteTransaction((db) => {
      deps.preferenceRepo.upsert(db, {
        id: deps.idGenerator(),
        principalId: userId,
        category: "uix",
        key,
        value: value as never,
        source: "explicit",
        confidence: 1,
        nowIso: deps.nowIso(),
      });
    });
  }

  function readProfile(userId: string): FridayCrossBorderOperatingProfile | null {
    return readPreference(userId, PROFILE_KEY, normalizeProfile);
  }

  function readImports(userId: string): FridayCrossBorderImportBatch[] {
    return readPreference(userId, IMPORTS_KEY, (value) => normalizeImportBatches(value)) ?? [];
  }

  function readWorkflowAutomations(userId: string): FridayCrossBorderWorkflowAutomationRecord[] {
    return readPreference(userId, WORKFLOW_AUTOMATIONS_KEY, (value) => normalizeWorkflowAutomationRecords(value)) ?? [];
  }

  function writeWorkflowAutomations(userId: string, value: FridayCrossBorderWorkflowAutomationRecord[]): void {
    writePreference(userId, WORKFLOW_AUTOMATIONS_KEY, value);
  }

  function recoverWorkflowAutomationRecords(
    userId: string,
    existing: FridayCrossBorderWorkflowAutomationRecord[],
  ): FridayCrossBorderWorkflowAutomationRecord[] {
    const persistedIds = new Set(existing.map((record) => record.workflowId));
    const managedWorkflows = deps.workflowRuntime.crud.listWorkflows?.({
      tag: CROSS_BORDER_MANAGED_WORKFLOW_TAG,
      archived: false,
      limit: 200,
    }) ?? [];
    const recovered = managedWorkflows.flatMap((workflow) => {
      if (workflow.ownerUserId !== userId || workflow.isArchived) {
        return [];
      }
      const workflowId = parseManagedWorkflowPresetId(workflow.tags);
      if (!workflowId || persistedIds.has(workflowId)) {
        return [];
      }
      const entry = getFridayCrossBorderWorkflowCatalogEntry(workflowId);
      const registration = deps.workflowRuntime.triggers
        .listRegistrations(workflow.id)
        .find((item) => item.triggerType === "cron");
      if (!registration?.cronExpression || !registration.cronTimezone) {
        return [];
      }
      const publishedVersion = deps.workflowRuntime.crud.getPublishedVersion?.(workflow.id);
      const status: FridayCrossBorderWorkflowAutomationState["status"] = registration.enabled ? "active" : "paused";
      return [{
        workflowId,
        templateId: entry.templateId,
        managedWorkflowId: workflow.id,
        ...(publishedVersion?.id ? { managedWorkflowVersionId: publishedVersion.id } : {}),
        managedWorkflowSlug: workflow.slug,
        managedWorkflowName: workflow.name,
        status,
        schedule: {
          cron: registration.cronExpression,
          timezone: registration.cronTimezone,
        },
        ...(registration.id ? { triggerRegistrationId: registration.id } : {}),
        ...(registration.nextFireAt ? { nextRunAt: registration.nextFireAt } : {}),
        lastPublishedAt: publishedVersion?.createdAt ?? workflow.updatedAt,
        lastSyncedAt: deps.nowIso(),
      }];
    });
    if (recovered.length === 0) {
      return existing;
    }
    return [...existing, ...recovered]
      .sort((left, right) => left.workflowId.localeCompare(right.workflowId));
  }

  function resolveWorkflowAutomationRecords(userId: string): FridayCrossBorderWorkflowAutomationRecord[] {
    const existing = recoverWorkflowAutomationRecords(userId, readWorkflowAutomations(userId));
    const now = deps.nowIso();
    const nextRecords = existing.flatMap((record) => {
      const workflow = deps.workflowRuntime.crud.getWorkflow(record.managedWorkflowId);
      if (!workflow || workflow.ownerUserId !== userId || workflow.isArchived) {
        return [];
      }
      const registration = deps.workflowRuntime.triggers
        .listRegistrations(record.managedWorkflowId)
        .find((item) => item.triggerType === "cron");
      const status: FridayCrossBorderWorkflowAutomationState["status"] = registration
        ? registration.enabled ? "active" : "paused"
        : "inactive";
      return [{
        ...record,
        status,
        ...(registration ? { triggerRegistrationId: registration.id } : {}),
        ...(registration?.nextFireAt ? { nextRunAt: registration.nextFireAt } : {}),
        lastSyncedAt: now,
      }];
    });
    if (JSON.stringify(existing) !== JSON.stringify(nextRecords)) {
      writeWorkflowAutomations(userId, nextRecords);
    }
    return nextRecords;
  }

  function createManagedDraft(input: {
    workflowId: string;
    workflowPresetId: FridayCrossBorderWorkflowId;
    title: string;
    timezone: string;
    ownerUserId: string;
  }) {
    const entry = getFridayCrossBorderWorkflowCatalogEntry(input.workflowPresetId);
    const template = deps.workflowBuilderRuntime.templates.getTemplate(entry.templateId);
    if (!template) {
      throw new FridayDomainError("WORKFLOW_TEMPLATE_NOT_FOUND", `Workflow template ${entry.templateId} is not available`, {
        httpStatus: 404,
      });
    }
    const schedule = buildWorkflowSchedule(input.workflowPresetId, input.timezone);
    const spec = JSON.parse(JSON.stringify(template.spec)) as typeof template.spec;
    const visual = JSON.parse(JSON.stringify(template.visual)) as typeof template.visual;
    spec.workflowId = input.workflowId;
    visual.workflowId = input.workflowId;
    spec.trigger = {
      type: "schedule",
      cron: schedule.cron,
      timezone: schedule.timezone,
    };
    return {
      draft: deps.workflowBuilderRuntime.drafts.createDraft({
        workflowId: input.workflowId,
        title: input.title,
        spec,
        visual,
        ownerUserId: input.ownerUserId,
      }),
      schedule,
    };
  }

  async function ensureManagedWorkflowForPreset(input: {
    userId: string;
    workflowPresetId: FridayCrossBorderWorkflowId;
    timezone: string;
    respectStartPausePolicy?: boolean;
  }): Promise<FridayCrossBorderWorkflowAutomationRecord> {
    const profile = readProfile(input.userId);
    if (!profile) {
      throw new FridayDomainError("CROSS_BORDER_PROFILE_REQUIRED", "Save the cross-border operating profile before enabling workflows", {
        httpStatus: 409,
      });
    }

    const entry = getFridayCrossBorderWorkflowCatalogEntry(input.workflowPresetId);
    const desiredSlug = buildManagedWorkflowSlug({
      userId: input.userId,
      regionFocus: profile.regionFocus,
      workflowId: input.workflowPresetId,
    });
    const desiredName = buildManagedWorkflowName({
      profile,
      workflowId: input.workflowPresetId,
    });
    const now = deps.nowIso();
    const existingRecords = readWorkflowAutomations(input.userId);
    const existingRecord = existingRecords.find((record) => record.workflowId === input.workflowPresetId) ?? null;
    const imports = readImports(input.userId)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    let workflow = existingRecord
      ? deps.workflowRuntime.crud.getWorkflow(existingRecord.managedWorkflowId)
      : deps.workflowRuntime.crud.getWorkflowBySlug(desiredSlug);

    if (workflow && workflow.ownerUserId !== input.userId) {
      throw new FridayDomainError("WORKFLOW_SLUG_CONFLICT", `Managed workflow slug '${desiredSlug}' belongs to another owner`, {
        httpStatus: 409,
      });
    }

    if (!workflow) {
      workflow = deps.workflowRuntime.crud.createWorkflow({
        slug: desiredSlug,
        name: desiredName,
        description: entry.templateDescription,
        ownerUserId: input.userId,
        tags: [
          "cross-border",
          CROSS_BORDER_MANAGED_WORKFLOW_TAG,
          `cross-border-preset:${input.workflowPresetId}`,
          `cross-border-region:${profile.regionFocus}`,
        ],
      });
    }

    const { draft, schedule } = createManagedDraft({
      workflowId: workflow.id,
      workflowPresetId: input.workflowPresetId,
      title: `${desiredName} Draft`,
      timezone: input.timezone,
      ownerUserId: input.userId,
    });

    const deployment = await deps.workflowProductService.deployDraft({
      workflowId: workflow.id,
      draftId: draft.draftId,
      actorUserId: input.userId,
      resyncTriggers: true,
      runNow: false,
      changeNote: `Enable ${input.workflowPresetId} for the cross-border operating pack`,
    });

    const registration = deps.workflowRuntime.triggers
      .listRegistrations(workflow.id)
      .find((item) => item.triggerType === "cron");
    const currentGuidance = buildWorkflowCurrentGuidance({
      workflowId: input.workflowPresetId,
      profile,
      imports,
      nowIso: now,
    });
    if (registration && input.respectStartPausePolicy !== false && currentGuidance.shouldStartPaused) {
      await deps.workflowRuntime.triggers.setRegistrationEnabled(registration.id, false);
    }
    const finalRegistration = deps.workflowRuntime.triggers
      .listRegistrations(workflow.id)
      .find((item) => item.triggerType === "cron");

    const record: FridayCrossBorderWorkflowAutomationRecord = {
      workflowId: input.workflowPresetId,
      templateId: entry.templateId,
      managedWorkflowId: workflow.id,
      managedWorkflowVersionId: deployment.workflowVersionId,
      managedWorkflowSlug: workflow.slug,
      managedWorkflowName: workflow.name,
      status: finalRegistration?.enabled === false ? "paused" : "active",
      schedule,
      ...(finalRegistration ? { triggerRegistrationId: finalRegistration.id } : {}),
      ...(finalRegistration?.nextFireAt ? { nextRunAt: finalRegistration.nextFireAt } : {}),
      lastPublishedAt: now,
      lastSyncedAt: now,
    };

    const nextRecords = [
      ...existingRecords.filter((item) => item.workflowId !== input.workflowPresetId),
      record,
    ].sort((left, right) => left.workflowId.localeCompare(right.workflowId));
    writeWorkflowAutomations(input.userId, nextRecords);
    return record;
  }

  return {
    getProfile(input) {
      return readProfile(input.userId);
    },

    upsertProfile(input) {
      validateProfileInput(input.profile);
      const now = deps.nowIso();
      const existing = readProfile(input.userId);
      const platforms = resolvePlatforms(input.profile.regionFocus);
      const profile: FridayCrossBorderOperatingProfile = {
        packId: FRIDAY_CROSS_BORDER_PACK_ID,
        regionFocus: input.profile.regionFocus,
        ...platforms,
        storeStage: input.profile.storeStage,
        categoryL1: input.profile.categoryL1.trim(),
        categoryL2: input.profile.categoryL2.trim(),
        fulfillmentMode: input.profile.fulfillmentMode,
        priceBand: input.profile.priceBand.trim(),
        adUsage: input.profile.adUsage,
        customerServiceMode: input.profile.customerServiceMode,
        monitoringDepth: input.profile.monitoringDepth,
        watchTargets: buildDefaultWatchTargets(input.profile, deps.idGenerator),
        competitorTargets: uniqueById(input.profile.competitorTargets).slice(0, 12),
        workflowPreset: buildDefaultWorkflowPreset(),
        adaptationState: existing?.adaptationState ?? {
          status: "tracking",
          firstReviewDueAt: addDays(now, 7),
          stableReviewDueAt: addDays(now, 30),
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      writePreference(input.userId, PROFILE_KEY, profile);
      return profile;
    },

    importBatch(input) {
      validateImportInput(input.batch);
      const imports = readImports(input.userId);
      const batch: FridayCrossBorderImportBatch = {
        id: deps.idGenerator(),
        kind: input.batch.kind,
        source: input.batch.source,
        title: input.batch.title.trim(),
        ...(input.batch.rawText?.trim() ? { rawText: input.batch.rawText.trim() } : {}),
        publicLinks: (input.batch.publicLinks ?? []).map((item) => item.trim()).filter((item) => item.length > 0).slice(0, MAX_LINKS_PER_IMPORT),
        fileNames: (input.batch.fileNames ?? []).map((item) => item.trim()).filter((item) => item.length > 0).slice(0, MAX_FILE_NAMES_PER_IMPORT),
        createdAt: deps.nowIso(),
      };
      writePreference(input.userId, IMPORTS_KEY, [batch, ...imports].slice(0, MAX_IMPORT_BATCHES));
      return batch;
    },

    getSnapshot(input) {
      const profile = readProfile(input.userId);
      const imports = readImports(input.userId)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
      const automationRecords = resolveWorkflowAutomationRecords(input.userId);
      return buildSnapshot(deps.nowIso(), profile, imports, automationRecords);
    },

    async applyWorkflowPreset(input) {
      const profile = readProfile(input.userId);
      if (!profile) {
        throw new FridayDomainError("CROSS_BORDER_PROFILE_REQUIRED", "Save the cross-border operating profile before enabling workflows", {
          httpStatus: 409,
        });
      }
      const workflowIds = (input.preset.workflowIds?.length
        ? input.preset.workflowIds
        : profile.workflowPreset)
        .filter((item, index, list) => list.indexOf(item) === index);
      for (const workflowId of workflowIds) {
        await ensureManagedWorkflowForPreset({
          userId: input.userId,
          workflowPresetId: workflowId,
          timezone: input.preset.timezone,
          respectStartPausePolicy: true,
        });
      }
      return this.getSnapshot({ userId: input.userId });
    },

    async setWorkflowPresetEnabled(input) {
      const automationRecords = resolveWorkflowAutomationRecords(input.userId);
      const existing = automationRecords.find((record) => record.workflowId === input.preset.workflowId) ?? null;
      if (input.preset.enabled) {
        if (existing) {
          await deps.workflowRuntime.triggers.syncPublishedVersionTriggers(existing.managedWorkflowId);
          const refreshed = resolveWorkflowAutomationRecords(input.userId);
          writeWorkflowAutomations(input.userId, refreshed);
          return this.getSnapshot({ userId: input.userId });
        }
        if (!input.preset.timezone) {
          throw new FridayDomainError("VALIDATION_ERROR", "timezone is required when enabling a workflow preset", {
            httpStatus: 400,
          });
        }
        await ensureManagedWorkflowForPreset({
          userId: input.userId,
          workflowPresetId: input.preset.workflowId,
          timezone: input.preset.timezone,
          respectStartPausePolicy: false,
        });
        return this.getSnapshot({ userId: input.userId });
      }

      if (!existing) {
        return this.getSnapshot({ userId: input.userId });
      }
      const registrations = deps.workflowRuntime.triggers.listRegistrations(existing.managedWorkflowId);
      for (const registration of registrations) {
        if (registration.triggerType === "cron") {
          await deps.workflowRuntime.triggers.setRegistrationEnabled(registration.id, false);
        }
      }
      const refreshed = resolveWorkflowAutomationRecords(input.userId);
      writeWorkflowAutomations(input.userId, refreshed);
      return this.getSnapshot({ userId: input.userId });
    },

    buildWorkflowInputContext(input) {
      const automationRecords = resolveWorkflowAutomationRecords(input.userId);
      const managedRecord = automationRecords.find((record) => record.managedWorkflowId === input.managedWorkflowId);
      if (!managedRecord) {
        return null;
      }
      const profile = readProfile(input.userId);
      if (!profile) {
        return null;
      }
      const imports = readImports(input.userId)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
      const snapshot = buildSnapshot(deps.nowIso(), profile, imports, automationRecords);
      return buildWorkflowInputPayload({
        workflowId: managedRecord.workflowId,
        profile,
        snapshot,
      });
    },
  };
}
